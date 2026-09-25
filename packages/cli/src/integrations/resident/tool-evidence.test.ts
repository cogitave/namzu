import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskResidentAgenda,
	MockLLMProvider,
	ProviderRegistry,
	type ResidentStepContext,
	ToolManager,
	type TurnId,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { parseExecFlags } from '../../commands/exec-flags.js'
import type { CommandContext } from '../../commands/types.js'
import { PROVIDER_REGISTRY } from '../providers/index.js'
import { openSessions } from '../sessions/store.js'
import { createResidentSessionStep } from './session-step.js'
import { findResidentProject } from './storage.js'
import { residentToolEvidence } from './tool-evidence.js'

const registries = new Map<string, ToolManager>()
vi.mock('@namzu/sdk', async (original) => {
	const actual = await original<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Parameters<typeof actual.query>[0]) => {
			if (params.turnId)
				registries.set(
					params.turnId,
					new ToolManager({ toolsets: params.toolsets, messages: () => [] }),
				)
			return actual.query(params)
		},
	}
})

/** The slug the CLI filed the workspace's project under: where each step's log lands. */
async function projectSlug(home: string, cwd: string): Promise<string> {
	const project = await findResidentProject(home, await realpath(cwd))
	if (!project) throw new Error('The workspace project is not filed under projects/.')
	return project.slug
}
vi.mock('../../tui/agent.js', async (original) => {
	const actual = await original<typeof import('../../tui/agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: {
				version: 3,
				providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
				subagents: { active: [] },
			},
			detected: [
				{
					entry: PROVIDER_REGISTRY.anthropic,
					source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
					apiKey: 'fixture-only',
					alternatives: [],
				},
			],
		}),
	}
})
const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	registries.clear()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it.each([
	['resident', false],
	['interactive', false],
	['resident', true],
	['interactive', true],
] as const)(
	'recalls original tool output through isolated real CLI sessions with the %s profile (automatic=%s)',
	async (contextProfile, automatic) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-resident-tool-cli-'))
		roots.push(root)
		const cwd = join(root, 'workspace')
		await mkdir(cwd)
		const sessions = await openSessions(cwd, { stateRoot: join(root, 'home') })
		const slug = await projectSlug(sessions.root, cwd)
		const agenda = new DiskResidentAgenda(join(root, 'agenda'), {
			tenantId: sessions.tenantId,
			agentKey: 'reviewer',
		})
		const pursuit = await agenda.add(
			await agenda.create('Review recorded evidence.'),
			'Recover the DELTA receipt without rereading its mutable source.',
		)
		const execution = agenda.execution(pursuit.id)
		const artifactsRoot = join(root, 'attempts')
		const receipt = 'DELTA EXACT-CODE-739 🦉'
		const document = Array.from({ length: 300 }, (_, i) =>
			i === 150 ? receipt : `row ${i}: ${'unimportant '.repeat(40)}`,
		).join('\n')
		await writeFile(join(cwd, 'source.txt'), document)
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'read-source-once', name: 'read', args: { path: 'source.txt' } }] },
				{
					text: '{"kind":"wait","summary":"Source observed; await confirmation.","wakeAfterMs":null}',
				},
			],
		})
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const ctx: CommandContext = {
			config: {
				sandbox: { enabled: false },
				web: { search: 'off' },
				compaction: { recallEvidence: automatic },
			},
			formatter: { name: 'text', print: vi.fn(), info: vi.fn(), error: vi.fn() },
		}
		const step = createResidentSessionStep({
			ctx,
			cwd,
			sessions,
			agenda,
			artifactsRoot,
			projectSlug: slug,
			contextProfile,
			toolLoading: 'deferred',
			flags: parseExecFlags(['--permission-mode', 'plan', '--max-iterations', '10']),
		})
		const invoke = async () => {
			const claim = await execution.claim((await execution.read())!, Date.now())
			const snapshot = (await agenda.read())!
			const context: ResidentStepContext = { agendaRevision: snapshot.revision }
			const result = await step({ ...pursuit, state: claim }, new AbortController().signal, context)
			await execution.settle(claim, result, Date.now())
			return claim
		}
		const firstClaim = await invoke()
		const firstRevision = (await agenda.read())!.revision
		await writeFile(
			join(cwd, 'source.txt'),
			'Manually replaced: the original receipt is no longer here.',
		)
		const source = residentToolEvidence(
			agenda.history((await execution.read())!, firstRevision),
			sessions,
			slug,
			artifactsRoot,
		)
		let page = await source.search({ query: 'DELTA' })
		while (!page.evidence?.matches.length && page.nextCursor)
			page = await source.search({ query: 'DELTA', cursor: page.nextCursor })
		expect(page.incomplete).toBe(page.nextCursor !== null)
		expect(page.evidence?.matches[0]?.excerpt).toContain(receipt)
		const tokenPage = await source.search({ terms: ['delta'] })
		const tokenMatch = tokenPage.evidence?.matches.find((entry) => entry.excerpt.includes(receipt))
		expect(tokenMatch).toBeDefined()
		if (!tokenPage.nextCursor) throw new Error('Expected remaining history.')
		const reopenedSource = residentToolEvidence(
			agenda.history((await execution.read())!, firstRevision),
			sessions,
			slug,
			artifactsRoot,
		)
		const continued = await reopenedSource.search({ cursor: tokenPage.nextCursor })
		expect(continued.nextCursor).toBeNull()
		expect(continued.evidence).toBeNull()
		const match = page.evidence!.matches[0]!
		const bounded = await source.search({ query: 'DELTA', maxReadBytes: 2 * 1024 * 1024 })
		expect(bounded.evidence?.matches[0]?.excerpt).toContain(receipt)
		expect(bounded.chargedBytes).toBe(
			bounded.historyBytes + 3 * 65_536 + (bounded.evidence?.scannedBytes ?? 0),
		)
		expect(bounded.chargedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
		const boundedRead = await source.read({
			revision: firstRevision,
			address: match.address,
			byteOffset: match.byteOffset,
			maxReadBytes: 2 * 1024 * 1024,
		})
		expect(boundedRead.text).toContain(receipt)
		expect(boundedRead.chargedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
		const reader = new MockLLMProvider({
			turns: automatic
				? [{ text: JSON.stringify({ kind: 'complete', summary: receipt }) }]
				: [
						{
							toolCalls: [
								{ id: 'search-recorded', name: 'search_resident_tools', args: { query: 'DELTA' } },
							],
						},
						{
							toolCalls: [
								{
									id: 'read-recorded',
									name: 'read_resident_tool',
									args: {
										revision: firstRevision,
										address: match.address,
										byteOffset: match.byteOffset,
									},
								},
							],
						},
						{ text: JSON.stringify({ kind: 'complete', summary: receipt }) },
					],
		})
		vi.mocked(ProviderRegistry.create).mockReturnValue({ provider: reader } as never)
		await agenda.wake(
			pursuit.id,
			(await execution.read())!,
			'Confirm the original retained DELTA receipt.',
			Date.now(),
		)
		const secondClaim = await invoke()
		if (automatic) {
			expect(reader.requests).toHaveLength(1)
			const first = JSON.stringify(reader.requests[0])
			expect(first).toContain(receipt)
			expect(first).toContain('Retrieved resident evidence')
			expect(first).toContain('derived_summary')
			expect(first).not.toContain('Manually replaced:')
			expect(first).toContain('read_resident_tool')
		} else {
			expect(reader.requests).toHaveLength(3)
			expect(JSON.stringify(reader.requests[0]?.messages)).not.toContain(receipt)
			expect(
				JSON.stringify(reader.requests[2]?.messages.filter((message) => message.role === 'tool')),
			).toContain(receipt)
		}
		expect(reader.requests[0]?.tools?.map((tool) => tool.function.name)).toContain(
			'search_resident_tools',
		)
		expect(await readFile(join(cwd, 'source.txt'), 'utf8')).toContain('Manually replaced')
		const receipts = await Promise.all(
			[firstClaim, secondClaim].map(async (claim) =>
				JSON.parse(await readFile(join(artifactsRoot, claim.claimId!, 'finish.json'), 'utf8')),
			),
		)
		expect(new Set(receipts.map((receipt) => receipt.sessionId)).size).toBe(2)
		expect(receipts.every((receipt) => receipt.cleanup === 'confirmed')).toBe(true)
		for (const [turnId, registry] of registries) {
			const tool = registry.get('search_resident_tools')
			if (!tool) continue
			for (const requestingTurn of [turnId as TurnId, generateTurnId()]) {
				const denied = await tool.execute(
					{},
					{
						sessionId: generateSessionId(),
						turnId: requestingTurn,
						workingDirectory: cwd,
						env: {},
						log() {},
						abortSignal: new AbortController().signal,
					},
				)
				expect(denied.success).toBe(false)
			}
		}
		// The evidence was read from the step's own session log, filed under the project.
		expect(
			(await stat(join(sessions.root, 'projects', slug, `${receipts[0].sessionId}.jsonl`))).size,
		).toBeGreaterThan(0)
		const wrongFinish = join(artifactsRoot, firstClaim.claimId!, 'finish.json')
		await writeFile(
			wrongFinish,
			JSON.stringify({ ...receipts[0], sessionId: receipts[1].sessionId }),
		)
		await expect(source.read({ revision: firstRevision, address: match.address })).rejects.toThrow(
			'Attempt identity',
		)
	},
)

it.each([false, true])(
	'automatically retains original and corrected observations across three real resident admissions (long state=%s)',
	async (longState) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-resident-correction-'))
		roots.push(root)
		const cwd = join(root, 'workspace')
		await mkdir(cwd)
		const sessions = await openSessions(cwd, { stateRoot: join(root, 'home') })
		const slug = await projectSlug(sessions.root, cwd)
		const agendaRoot = join(root, 'agenda')
		const agenda = new DiskResidentAgenda(agendaRoot, {
			tenantId: sessions.tenantId,
			agentKey: 'reviewer',
		})
		const pursuit = await agenda.add(
			await agenda.create('Inspect DELTA.'),
			longState
				? `Compare DELTA original and corrected observations. Atlas deployment and Borealis routing have separate notes. ${'Keep the report clear and tie claims to original evidence. '.repeat(100)}`
				: 'Compare DELTA original and corrected observations.',
		)
		const execution = agenda.execution(pursuit.id)
		const artifactsRoot = join(root, 'attempts')
		const ctx: CommandContext = {
			config: { sandbox: { enabled: false }, web: { search: 'off' } },
			formatter: { name: 'text', print: vi.fn(), info: vi.fn(), error: vi.fn() },
		}
		const invoke = async (provider: MockLLMProvider, currentAgenda = agenda) => {
			vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
			const claim = await execution.claim((await execution.read())!, Date.now())
			const current = await currentAgenda.read()
			if (!current) throw new Error('Missing agenda.')
			const step = createResidentSessionStep({
				ctx,
				cwd,
				sessions,
				agenda: currentAgenda,
				artifactsRoot,
				projectSlug: slug,
				flags: parseExecFlags(['--max-iterations', '4']),
				toolLoading: 'deferred',
			})
			const result = await step({ ...pursuit, state: claim }, new AbortController().signal, {
				agendaRevision: current.revision,
			})
			await execution.settle(claim, result, Date.now())
			return claim
		}
		const original = `DELTA initial observation: OLD-${generateTurnId()}`
		const corrected = `DELTA corrected observation: NEW-${generateTurnId()}`
		const observe = () =>
			new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'observe-once', name: 'read', args: { path: 'receipt.txt' } }] },
					{
						text: JSON.stringify({
							kind: 'wait',
							summary: `DELTA derived claim: UNVERIFIED-CODE. Await confirmation. ${longState ? 'Routine operational checks were reviewed. '.repeat(150) : ''}`,
							wakeAfterMs: null,
						}),
					},
				],
			})
		await writeFile(join(cwd, 'receipt.txt'), original)
		const first = await invoke(observe())
		const firstState = await execution.read()
		if (!firstState) throw new Error('Missing first settlement.')
		await writeFile(join(cwd, 'receipt.txt'), corrected)
		await agenda.wake(
			pursuit.id,
			firstState,
			'DELTA source changed. Observe its current corrected contents.',
			Date.now(),
		)
		const second = await invoke(observe())
		const secondState = await execution.read()
		if (!secondState) throw new Error('Missing second settlement.')
		await writeFile(
			join(cwd, 'receipt.txt'),
			'Both observations have now been removed from the workspace.',
		)
		await agenda.wake(
			pursuit.id,
			secondState,
			longState
				? 'Operations reviewed delivery progress across regions and checked outstanding paperwork before the final review. Compare original and corrected DELTA.'
				: 'Compare the initial and corrected DELTA records.',
			Date.now(),
		)
		const reopened = new DiskResidentAgenda(agendaRoot, {
			tenantId: sessions.tenantId,
			agentKey: 'reviewer',
		})
		const provider = new MockLLMProvider({
			turns: [
				{
					text: '{"kind":"complete","summary":"Both historical observations supplied to this request."}',
				},
			],
		})
		const third = await invoke(provider, reopened)
		const textValues = (value: unknown): string[] =>
			typeof value === 'string'
				? [value]
				: value && typeof value === 'object'
					? Object.values(value).flatMap(textValues)
					: []
		const blocks = textValues(provider.requests[0]).filter((text) =>
			text.includes('Retrieved resident evidence'),
		)
		const records = blocks.flatMap((text) =>
			text
				.split('\n')
				.filter((line) => line.startsWith('{"sessionId":'))
				.map((line) => JSON.parse(line)),
		)
		expect(provider.requests).toHaveLength(1)
		expect(records.map((record) => record.excerpt).join('\n')).toContain(original)
		expect(records.map((record) => record.excerpt).join('\n')).toContain(corrected)
		expect(records.map((record) => record.excerpt).join('\n')).not.toContain('UNVERIFIED-CODE')
		expect(new Set(records.map((record) => record.sessionId)).size).toBe(2)
		const ordered = [...records].sort((a, b) => a.revision - b.revision)
		expect(ordered[0].excerpt).toContain(original)
		expect(ordered.at(-1).excerpt).toContain(corrected)
		const finishes = await Promise.all(
			[first, second, third].map(async (claim) =>
				JSON.parse(await readFile(join(artifactsRoot, claim.claimId!, 'finish.json'), 'utf8')),
			),
		)
		expect(new Set(finishes.map((receipt) => receipt.sessionId)).size).toBe(3)
		expect(finishes.every((receipt) => receipt.cleanup === 'confirmed')).toBe(true)
		expect(await readFile(join(cwd, 'receipt.txt'), 'utf8')).toContain('removed from the workspace')
	},
)
