import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskResidentAgenda,
	MockLLMProvider,
	ProviderRegistry,
	type ResidentStepContext,
	type ToolRegistryContract,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { parseRunFlags } from '../../commands/run-flags.js'
import type { CommandContext } from '../../commands/types.js'
import { PROVIDER_REGISTRY } from '../providers/index.js'
import { openSessions } from '../sessions/store.js'
import { createResidentSessionStep } from './session-step.js'
import { residentToolEvidence } from './tool-evidence.js'

const registries = new Map<string, ToolRegistryContract>()
vi.mock('@namzu/sdk', async (original) => {
	const actual = await original<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Parameters<typeof actual.query>[0]) => {
			if (params.runId) registries.set(params.runId, params.tools)
			return actual.query(params)
		},
	}
})
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

it.each(['resident', 'interactive'] as const)(
	'recalls original tool output through isolated real CLI sessions with the %s profile',
	async (contextProfile) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-resident-tool-cli-'))
		roots.push(root)
		const cwd = join(root, 'workspace')
		await mkdir(cwd)
		const sessions = await openSessions(cwd, { stateRoot: join(root, 'home') })
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
			config: { sandbox: { enabled: false }, web: { search: 'off' } },
			formatter: { name: 'text', print: vi.fn(), info: vi.fn(), error: vi.fn() },
		}
		const step = createResidentSessionStep({
			ctx,
			cwd,
			sessions,
			agenda,
			artifactsRoot,
			contextProfile,
			toolLoading: 'deferred',
			flags: parseRunFlags(['--permission-mode', 'plan', '--max-iterations', '10']),
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
			artifactsRoot,
		)
		let page = await source.search({ query: 'DELTA' })
		while (!page.evidence?.matches.length && page.nextCursor)
			page = await source.search({ query: 'DELTA', cursor: page.nextCursor })
		expect(page.incomplete).toBe(false)
		expect(page.evidence?.matches[0]?.excerpt).toContain(receipt)
		const match = page.evidence!.matches[0]!
		const bounded = await source.search({ query: 'DELTA', maxReadBytes: 2 * 1024 * 1024 })
		expect(bounded.evidence?.matches[0]?.excerpt).toContain(receipt)
		expect(bounded.chargedBytes).toBe(
			bounded.historyBytes + 2 * 65_536 + (bounded.evidence?.scannedBytes ?? 0),
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
			turns: [
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
		expect(reader.requests).toHaveLength(3)
		expect(JSON.stringify(reader.requests[0]?.messages)).not.toContain(receipt)
		expect(
			JSON.stringify(reader.requests[2]?.messages.filter((message) => message.role === 'tool')),
		).toContain(receipt)
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
		for (const [runId, registry] of registries) {
			const tool = registry.get('search_resident_tools')
			if (!tool) continue
			for (const requestingRun of [runId, generateRunId()]) {
				const denied = await tool.execute(
					{},
					{
						runId: requestingRun as ReturnType<typeof generateRunId>,
						workingDirectory: cwd,
						env: {},
						log() {},
						abortSignal: new AbortController().signal,
					},
				)
				expect(denied.success).toBe(false)
			}
		}
		expect(
			(
				await readdir(
					join(
						sessions.root,
						'sessions',
						receipts[0].sessionId,
						'runs',
						receipts[0].runId,
						'evidence-index',
					),
				)
			).length,
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
