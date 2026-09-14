import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskResidentAgenda,
	type LLMProvider,
	MockLLMProvider,
	ProviderRegistry,
	type ToolRegistryContract,
	createUserMessage,
	generateRunId,
	generateSessionId,
	hashResidentSkill,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { openSessions } from '../../integrations/sessions/store.js'
import { type AgentSession, type RunScope, createAgentSession } from '../agent.js'

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

const roots: string[] = []
const opened: AgentSession[] = []
afterEach(async () => {
	for (const session of opened.splice(0)) await session.close()
	vi.restoreAllMocks()
	registries.clear()
	for (const root of roots.splice(0)) removeTempDir(root)
})
const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY[preferences.providers[0]!.id],
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

it('reaches earlier exact evidence through the real CLI session under plan permissions and deferred loading', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-resident-recall-session-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd, { stateRoot: join(cwd, 'state') })
	const agenda = new DiskResidentAgenda(join(cwd, 'resident'), {
		tenantId: sessions.tenantId,
		agentKey: 'test',
	})
	const pursuit = await agenda.add(
		await agenda.create('Review DELTA.'),
		'Recover the current delivery details.',
	)
	const execution = agenda.execution(pursuit.id)
	const firstWake = await agenda.wake(
		pursuit.id,
		pursuit.state,
		'DELTA receipt TOKEN-ALPHA; destination old depot.',
		1,
	)
	await execution.settle(
		await execution.claim(firstWake, 2),
		{ kind: 'wait', wakeAt: null, summary: 'First check finished.' },
		3,
	)
	const firstRevision = (await agenda.read())!.revision
	const secondWake = await agenda.wake(
		pursuit.id,
		(await execution.read())!,
		'DELTA correction: destination new depot.',
		4,
	)
	await execution.settle(
		await execution.claim(secondWake, 5),
		{ kind: 'wait', wakeAt: null, summary: 'Waiting for confirmation.' },
		6,
	)
	const admitted = (await agenda.read())!
	const history = new DiskResidentAgenda(join(cwd, 'resident'), {
		tenantId: sessions.tenantId,
		agentKey: 'test',
	}).history((await execution.read())!, admitted.revision)
	const scope: RunScope = {
		sessionId: generateSessionId(),
		topicId: sessions.topicId,
		projectId: sessions.projectId,
		tenantId: sessions.tenantId,
	}
	const runId = generateRunId()
	let checkedForeign = false
	const script = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'recall', name: 'search_resident_history', args: { query: 'DELTA' } }] },
			{
				toolCalls: [
					{ id: 'old', name: 'read_resident_history', args: { revision: firstRevision, part: 1 } },
				],
			},
			{
				toolCalls: [
					{
						id: 'new',
						name: 'read_resident_history',
						args: { revision: admitted.revision, part: 1 },
					},
				],
			},
			{ text: 'DELTA: TOKEN-ALPHA, destination new depot.' },
		],
	})
	const provider: LLMProvider = {
		id: 'history-test',
		name: 'History test',
		async *chatStream(params) {
			if (!checkedForeign) {
				const tool = registries.get(runId)?.get('search_resident_history')
				if (!tool) throw new Error('History tool was not mounted.')
				const denied = await tool.execute(
					{ query: 'DELTA' },
					{
						runId: generateRunId(),
						workingDirectory: cwd,
						abortSignal: new AbortController().signal,
						env: {},
						log() {},
					},
				)
				expect(denied.success).toBe(false)
				expect(denied.output).not.toContain('TOKEN-ALPHA')
				checkedForeign = true
			}
			yield* script.chatStream(params)
		},
	}
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		scope,
		stateRoot: sessions.root,
		residentHistory: history,
		permissionMode: 'plan',
		toolLoading: 'deferred',
		sandbox: { enabled: false },
	})
	opened.push(session)
	const events = []
	for await (const event of session.send(
		[createUserMessage('Report the earlier delivery code and corrected destination.')],
		{
			runId,
			permissionMode: 'plan',
			residentContext: {
				state: (await execution.read())!,
				history: history.scope,
				readOnly: true,
				outputInstructions: 'Report the current delivery details.',
			},
		},
	))
		events.push(event)
	expect(events.filter((event) => event.kind === 'error')).toEqual([])
	expect(events.filter((event) => event.kind === 'done').at(-1)).toMatchObject({
		stopReason: 'end_turn',
	})
	expect(checkedForeign).toBe(true)
	expect(script.requests).toHaveLength(4)
	expect(JSON.stringify(script.requests[0]?.messages)).not.toContain('TOKEN-ALPHA')
	const firstTools = script.requests[0]?.tools?.map((tool) => tool.function.name)
	expect(firstTools).toContain('search_resident_history')
	expect(firstTools).toContain('read_resident_history')
	const results = script.requests[3]?.messages.filter((message) => message.role === 'tool') ?? []
	expect(JSON.stringify(results)).toContain('TOKEN-ALPHA')
	expect(JSON.stringify(results)).toContain('new depot')
	const stale = await registries
		.get(runId)
		?.get('search_resident_history')
		?.execute(
			{ query: 'DELTA' },
			{
				runId,
				workingDirectory: cwd,
				abortSignal: new AbortController().signal,
				env: {},
				log() {},
			},
		)
	expect(stale?.success).toBe(false)
})

it('does not mount resident recall for an ordinary conversation', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-no-resident-recall-'))
	roots.push(cwd)
	const provider = new MockLLMProvider({ turns: [{ text: 'Ready.' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot: join(cwd, 'state'),
		sandbox: { enabled: false },
	})
	opened.push(session)
	expect(session.toolNames()).not.toContain('search_resident_history')
	expect(session.toolNames()).not.toContain('read_resident_history')
})

it('loads only requested resident guidance, rejects foreign and settled runs, and leaves the next send clean', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-resident-skills-session-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd, { stateRoot: join(cwd, 'state') })
	const agenda = new DiskResidentAgenda(join(cwd, 'resident'), {
		tenantId: sessions.tenantId,
		agentKey: 'test',
	})
	const pursuit = await agenda.add(
		await agenda.create('Inspect current evidence.'),
		'Verify the receipt.',
	)
	const candidate = {
		name: 'receipt-review',
		description: 'Verify a receipt.',
		body: 'UNIQUE_LEARNED_BODY: retain the complete receipt identifier.',
	}
	const hash = hashResidentSkill(candidate)
	const evidence = {
		key: 'host-fixture',
		source: 'test',
		reason: 'Test fixture, not measured model improvement.',
	}
	const learning = {
		revision: 1,
		preferences: [],
		skills: [
			{
				...candidate,
				hash,
				evidence,
				verification: {
					baselineHash: 'none' as const,
					candidateHash: hash,
					evidenceDigest: 'a'.repeat(64),
					verificationTasks: 5,
					confirmationTasks: 5,
				},
			},
		],
		lastChange: evidence,
	}
	const runId = generateRunId()
	const script = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{ id: 'load-skill', name: 'read_resident_skill', args: { name: candidate.name } },
				],
			},
			{ text: 'Receipt inspected.' },
			{ text: 'Ordinary conversation.' },
		],
	})
	let checkedForeign = false
	const provider: LLMProvider = {
		id: 'learning-test',
		name: 'Learning test',
		async *chatStream(params) {
			if (!checkedForeign) {
				const tool = registries.get(runId)?.get('read_resident_skill')
				expect(tool).toBeDefined()
				const result = await tool!.execute(
					{ name: candidate.name },
					{
						runId: generateRunId(),
						workingDirectory: cwd,
						abortSignal: new AbortController().signal,
						env: {},
						log() {},
					},
				)
				expect(result.success).toBe(false)
				expect(result.output).not.toContain(candidate.body)
				checkedForeign = true
			}
			yield* script.chatStream(params)
		},
	}
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot: sessions.root,
		scope: {
			sessionId: generateSessionId(),
			topicId: sessions.topicId,
			tenantId: sessions.tenantId,
			projectId: sessions.projectId,
		},
		permissionMode: 'plan',
		toolLoading: 'deferred',
		sandbox: { enabled: false },
	})
	opened.push(session)
	const events = []
	for await (const event of session.send(
		[createUserMessage('Use receipt-review to inspect the receipt.')],
		{
			runId,
			permissionMode: 'plan',
			residentLearningDisclosure: 'on-demand',
			residentContext: {
				state: pursuit.state,
				learning,
				outputInstructions: 'Return the receipt.',
			},
		},
	))
		events.push(event)
	expect(events.filter((event) => event.kind === 'error')).toEqual([])
	expect(events.find((event) => event.kind === 'done')).toMatchObject({ stopReason: 'end_turn' })
	expect(JSON.stringify(script.requests[0]!.messages)).not.toContain(candidate.body)
	expect(JSON.stringify(script.requests[1]!.messages)).toContain(candidate.body)
	expect(script.requests[0]!.tools?.map((t) => t.function.name)).toContain('read_resident_skill')
	expect(session.toolNames()).not.toContain('read_resident_skill')
	const stale = await registries
		.get(runId)!
		.get('read_resident_skill')!
		.execute(
			{ name: candidate.name },
			{
				runId,
				workingDirectory: cwd,
				abortSignal: new AbortController().signal,
				env: {},
				log() {},
			},
		)
	expect(stale.success).toBe(false)
	const nextId = generateRunId()
	for await (const _event of session.send([createUserMessage('Hello.')], {
		runId: nextId,
		permissionMode: 'plan',
	})) {
		/* drain */
	}
	expect(registries.get(nextId)?.get('read_resident_skill')).toBeUndefined()
	expect(script.requests[2]!.tools?.map((t) => t.function.name)).not.toContain(
		'read_resident_skill',
	)
})
