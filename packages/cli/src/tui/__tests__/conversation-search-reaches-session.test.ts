import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DefaultPathBuilder,
	DiskMemoryStore,
	type LLMProvider,
	MockLLMProvider,
	ProviderRegistry,
	type SessionId,
	ToolRegistry,
	type ToolRegistryContract,
	createUserMessage,
	defineTool,
	generateRunId,
	mcpJsonSchemaToZod,
	query,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import {
	type CliSessions,
	openSessions,
	replaceConversation,
	startConversation,
} from '../../integrations/sessions/store.js'
import { type AgentSession, type RunScope, createAgentSession } from '../agent.js'

const registries = new Map<string, ToolRegistryContract>()
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
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
		entry: PROVIDER_REGISTRY.anthropic,
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

/** Produce the original evidence through the SDK, then discard it from the chat projection. */
async function archive(cwd: string, sessions: CliSessions, sessionId: SessionId, text: string) {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'archive_observation',
			description: 'Return an exact observation.',
			inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: text }),
		}),
	)
	for await (const _event of query({
		provider: new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'observe', name: 'archive_observation', args: {} }] },
				{ text: 'Observation recorded.' },
			],
		}),
		tools,
		runConfig: { model: 'mock', timeoutMs: 10_000, tokenBudget: 100_000, maxIterations: 3 },
		agentId: 'archive-fixture',
		agentName: 'Archive fixture',
		messages: [createUserMessage('Inspect the original.')],
		workingDirectory: cwd,
		pathBuilder: new DefaultPathBuilder(sessions.root),
		sessionId,
		topicId: sessions.topicId,
		projectId: sessions.projectId,
		tenantId: sessions.tenantId,
		resumeHandler: async () => ({ action: 'continue' }),
	})) {
		// Consume the real SDK writer before replacing the chat projection.
	}
	await replaceConversation(sessions, sessionId, [createUserMessage('Compacted summary only.')])
}

async function send(session: AgentSession, runId = generateRunId()) {
	for await (const _event of session.send(
		[createUserMessage('Recover the previous exact detail.')],
		{
			runId,
			permissionMode: 'auto',
		},
	)) {
		// Consume the production adapter and kernel, including tool execution.
	}
}

it('keeps evidence attached to its invoking run when the host changes conversations', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-evidence-session-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd)
	const firstId = await startConversation(sessions)
	const secondId = await startConversation(sessions)
	await archive(cwd, sessions, firstId, 'ARCHIVE-TAG alpha-private-identifier')
	await archive(cwd, sessions, secondId, 'ARCHIVE-TAG beta-private-identifier')
	const scope: RunScope = {
		sessionId: firstId,
		topicId: sessions.topicId,
		projectId: sessions.projectId,
		tenantId: sessions.tenantId,
	}
	const releases = [deferred(), deferred()]
	const started = [false, false]
	let requests = 0
	const script = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{ id: 'search-first', name: 'search_conversation', args: { query: 'ARCHIVE-TAG' } },
				],
			},
			{ text: 'First conversation evidence recovered.' },
			{
				toolCalls: [
					{ id: 'search-second', name: 'search_conversation', args: { query: 'ARCHIVE-TAG' } },
				],
			},
			{ text: 'Second conversation evidence recovered.' },
		],
	})
	const provider: LLMProvider = {
		id: 'evidence-session',
		name: 'Evidence session',
		async *chatStream(params) {
			const index = requests++
			if (index === 0 || index === 2) {
				started[index / 2] = true
				await releases[index / 2]?.promise
			}
			yield* script.chatStream(params)
		},
	}
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		scope,
		stateRoot: sessions.root,
		conversationSessions: sessions,
		sandbox: { enabled: false },
	})
	opened.push(session)
	expect(session.toolNames()).toContain('search_conversation')
	expect(session.toolNames()).toContain('read_conversation')
	const firstRunId = generateRunId()
	let pending = send(session, firstRunId)
	pending.catch(() => {})
	try {
		await vi.waitFor(() => expect(started[0]).toBe(true))
		const tools = registries.get(firstRunId)
		const retained = tools?.get('search_conversation')
		if (!retained) throw new Error('The session did not mount its conversation search tool.')
		for (const name of ['bash', 'write', 'edit']) {
			expect(tools?.get(name)?.executionBarrier, `${name} lost its CLI barrier`).toBe(true)
		}
		expect(tools?.get('read')?.executionBarrier).not.toBe(true)
		scope.sessionId = secondId
		releases[0]?.resolve()
		await pending
		const firstResult = script.requests[1]?.messages.find(
			(message) => message.role === 'tool' && message.toolCallId === 'search-first',
		)
		expect(String(firstResult?.content)).toContain('alpha-private-identifier')
		expect(String(firstResult?.content)).not.toContain('beta-private-identifier')
		expect(
			script.requests[0]?.tools?.some((tool) => tool.function.name === 'search_conversation'),
		).toBe(true)

		pending = send(session)
		pending.catch(() => {})
		await vi.waitFor(() => expect(started[1]).toBe(true))
		// The registry outlives each send. Its retained callback must refuse a
		// departed or unknown owner instead of resolving the newly selected chat.
		for (const runId of [firstRunId, generateRunId()]) {
			const refused = await retained.execute(
				{ query: 'ARCHIVE-TAG' },
				{
					runId,
					workingDirectory: cwd,
					abortSignal: new AbortController().signal,
					env: {},
					log() {},
				},
			)
			expect(refused.success).toBe(false)
			expect(refused.output).toBe('')
			expect(refused.error).toContain('unavailable')
		}
		releases[1]?.resolve()
		await pending
		const secondResult = script.requests[3]?.messages.find(
			(message) => message.role === 'tool' && message.toolCallId === 'search-second',
		)
		expect(String(secondResult?.content)).toContain('beta-private-identifier')
		expect(String(secondResult?.content)).not.toContain('alpha-private-identifier')
	} finally {
		for (const release of releases) release.resolve()
		await pending.catch(() => {})
	}
})

it('does not offer conversation search without host-owned conversation storage', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-evidence-unmounted-'))
	roots.push(cwd)
	const provider = new MockLLMProvider({ turns: [{ text: 'No historical search configured.' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
	})
	opened.push(session)
	expect(session.toolNames()).not.toContain('search_conversation')
	expect(session.toolNames()).not.toContain('read_conversation')
	await send(session)
	expect(
		provider.requests[0]?.tools?.some((tool) => tool.function.name === 'search_conversation'),
	).toBe(false)
})

it('projects the task created by the actual run tools into the next provider request only', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-task-context-session-'))
	roots.push(cwd)
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'create-plan',
						name: 'task_create',
						args: {
							subject: 'TASK-SNAPSHOT sentinel',
							description: 'Check the artifact before delivery',
						},
					},
				],
			},
			{ text: 'Plan recorded.' },
			{ text: 'A new run has no inherited task snapshot.' },
		],
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		memory: { recall: false },
	})
	opened.push(session)
	await send(session)
	const systems = (index: number) =>
		provider.requests[index]?.messages
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n') ?? ''
	expect(systems(0)).not.toContain('Current run task snapshot.')
	expect(systems(1)).toContain('Current run task snapshot.')
	expect(systems(1)).toContain('TASK-SNAPSHOT sentinel')
	expect(systems(1)).toContain('"status":"pending"')
	await send(session)
	expect(systems(2)).not.toContain('Current run task snapshot.')
})

it.each([true, false])(
	'forwards identifier grounding policy %s into actual requests',
	async (identifierGrounding) => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-grounding-session-'))
		roots.push(cwd)
		const store = new DiskMemoryStore({ baseDir: join(cwd, '.namzu') })
		await store.create({
			title: 'opal9 connection',
			summary: 'A historical fact',
			content: 'opal9 timeout is 19 seconds.',
		})
		const provider = new MockLLMProvider({ turns: [{ text: 'UNKNOWN' }] })
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const session = await createAgentSession(preferences, detected, {
			cwd,
			sandbox: { enabled: false },
			memory: { identifierGrounding },
		})
		opened.push(session)
		for await (const _event of session.send(
			[createUserMessage('What is quartz8 delay in seconds?')],
			{ permissionMode: 'auto' },
		)) {
			/* consume production request */
		}
		const system =
			provider.requests[0]?.messages
				.filter((m) => m.role === 'system')
				.map((m) => m.content)
				.join('\n') ?? ''
		expect(system.includes('Retrieved project memory:')).toBe(!identifierGrounding)
	},
)
