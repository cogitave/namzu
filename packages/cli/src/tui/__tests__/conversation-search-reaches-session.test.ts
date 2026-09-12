import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskMemoryStore,
	type LLMProvider,
	type Message,
	MockLLMProvider,
	ProviderRegistry,
	type SessionId,
	ToolRegistry,
	type ToolRegistryContract,
	createAssistantMessage,
	createUserMessage,
	defineTool,
	generateRunId,
	mcpJsonSchemaToZod,
	query,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
	readConversationEvidence,
	searchConversation,
} from '../../integrations/sessions/conversation-search.js'
import { CliPathBuilder } from '../../integrations/sessions/paths.js'

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
	const runId = generateRunId()
	for await (const _event of query({
		runId,
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
		pathBuilder: new CliPathBuilder(sessions.root),
		sessionId,
		topicId: sessions.topicId,
		projectId: sessions.projectId,
		tenantId: sessions.tenantId,
		resumeHandler: async () => ({ action: 'continue' }),
	})) {
		// Consume the real SDK writer before replacing the chat projection.
	}
	await replaceConversation(sessions, sessionId, [createUserMessage('Compacted summary only.')])
	return runId
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
	const firstArchive = await archive(cwd, sessions, firstId, 'ARCHIVE-TAG alpha-private-identifier')
	const secondArchive = await archive(
		cwd,
		sessions,
		secondId,
		'ARCHIVE-TAG beta-private-identifier',
	)
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
					{
						id: 'search-first',
						name: 'search_conversation',
						args: { query: 'ARCHIVE-TAG', runId: firstArchive },
					},
				],
			},
			{ text: 'First conversation evidence recovered.' },
			{
				toolCalls: [
					{
						id: 'search-second',
						name: 'search_conversation',
						args: { query: 'ARCHIVE-TAG', runId: secondArchive },
					},
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

it('recovers oversized read output through a new CLI Session, then refuses altered artifacts and foreign ownership', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cli-retained-text-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd)
	const sessionId = await startConversation(sessions)
	const receipt = `DELTA ${randomUUID()}`
	const document = Array.from({ length: 400 }, (_, i) =>
		i === 210 ? receipt : `row ${i}: ${'α🦉 unchanged; '.repeat(30)}`,
	).join('\n')
	await writeFile(join(cwd, 'manifest.txt'), document)
	const seed = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'observe-once', name: 'read', args: { path: 'manifest.txt' } }] },
			{ text: 'The original observation is retained.' },
		],
	})
	const factory = vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider: seed } as never)
	const scope = {
		sessionId,
		topicId: sessions.topicId,
		tenantId: sessions.tenantId,
		projectId: sessions.projectId,
	}
	const first = await createAgentSession(preferences, detected, {
		cwd,
		scope,
		stateRoot: sessions.root,
		conversationSessions: sessions,
		sandbox: { enabled: false },
	})
	const runId = generateRunId()
	try {
		await send(first, runId)
	} finally {
		await first.close()
	}
	const runDir = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	const events = (await readFile(join(runDir, 'transcript.jsonl'), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
	const original = events.find(
		(event) => event.type === 'tool_completed' && event.toolName === 'read',
	)
	expect(original.outputTruncated).toBe(true)
	expect(original.result).not.toContain(receipt)
	expect(original.outputSpillIntegrity).toMatch(/^[a-f0-9]{64}$/)
	await writeFile(join(cwd, 'manifest.txt'), 'Manually replaced; the old receipt is gone.')
	await replaceConversation(sessions, sessionId, [
		createUserMessage('Compacted summary: an observation was recorded.'),
	])
	const reopened = await openSessions(cwd)
	const search = await searchConversation(reopened, sessionId, { query: 'DELTA', runId })
	const match = search.matches[0]!
	expect(match.text).toContain(receipt)
	expect(match.retained).toBe('full')
	expect(match.toolName).toBe('read')
	expect(match.byteOffset).toBeGreaterThan(40_000)
	const address = { runId, seq: match.seq, part: match.part, byteOffset: match.byteOffset }
	const reader = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{ id: 'search-old', name: 'search_conversation', args: { query: 'DELTA', runId } },
				],
			},
			{ toolCalls: [{ id: 'read-old', name: 'read_conversation', args: address }] },
			{ text: 'Recovered the original recorded observation.' },
		],
	})
	factory.mockReturnValue({ provider: reader } as never)
	let compactions = 0
	const second = await createAgentSession(preferences, detected, {
		cwd,
		scope,
		stateRoot: reopened.root,
		conversationSessions: reopened,
		sandbox: { enabled: false },
		toolLoading: 'deferred',
		compaction: { strategy: 'structured', contextWindowTokens: 32_000 },
		onRunEvent(event) {
			if (event.type === 'compaction_completed') compactions++
		},
	})
	opened.push(second)
	const history: Message[] = [createUserMessage(`${'old context '.repeat(1000)} ${receipt}`)]
	for (let i = 0; i < 20; i++)
		history.push(
			createUserMessage('irrelevant past investigation '.repeat(1000)),
			createAssistantMessage('old reasoning '.repeat(700)),
		)
	history.push(createUserMessage('Recover the original DELTA receipt.'))
	for await (const _event of second.send(history, { permissionMode: 'auto' })) {
		/* real CLI compaction and retrieval */
	}
	expect(compactions).toBeGreaterThan(0)
	expect(JSON.stringify(reader.requests[0]?.messages)).not.toContain(receipt)
	expect(
		JSON.stringify(
			reader.requests[2]?.messages.filter((m) => m.role === 'tool' && m.toolCallId === 'read-old'),
		),
	).toContain(receipt)
	expect(await readFile(join(cwd, 'manifest.txt'), 'utf8')).toContain('Manually replaced')
	expect(
		reader.requests
			.flatMap((r) =>
				r.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls ?? []),
			)
			.some((call) => call.function.name === 'read'),
	).toBe(false)
	const read = await readConversationEvidence(reopened, sessionId, address)
	expect(read.retainedPreview).toBe(false)
	const spill = original.outputSpillPath
	expect(typeof spill).toBe('string')
	const retained = await readFile(spill, 'utf8')
	expect(retained.slice(read.offset, read.offset + read.text.length)).toBe(read.text)
	expect(read.totalChars).toBe(retained.length)
	let cursor: string | undefined
	let all = ''
	let pages = 0
	do {
		const page = await readConversationEvidence(reopened, sessionId, {
			runId,
			seq: match.seq,
			part: match.part,
			cursor,
		})
		expect(page.offset).toBe(all.length)
		expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		all += page.text
		cursor = page.nextCursor
		expect(++pages).toBeLessThan(100)
	} while (cursor)
	expect(all).toBe(retained)

	await expect(
		readConversationEvidence(reopened, sessionId, {
			...address,
			byteOffset: address.byteOffset! + 1,
			cursor: read.nextCursor,
		}),
	).rejects.toThrow('scope or query')
	const bytes = await readFile(spill)
	bytes[address.byteOffset!] = 65
	await writeFile(spill, bytes)
	await expect(readConversationEvidence(reopened, sessionId, address)).rejects.toThrow('changed')
	const unavailable = await searchConversation(reopened, sessionId, { query: 'DELTA', runId })
	expect(unavailable).toMatchObject({ matches: [], incomplete: true, unavailableRuns: 1 })
	// An attacker cannot relabel a run under another conversation's otherwise valid directory.
	const metadata = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'))
	metadata.metadata.scope.sessionId = randomUUID()
	await writeFile(join(runDir, 'run.json'), JSON.stringify(metadata))
	await expect(readConversationEvidence(reopened, sessionId, address)).rejects.toThrow('ownership')
	expect(
		(await searchConversation(reopened, sessionId, { query: 'DELTA', runId })).matches,
	).toEqual([])
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

it('recovers retained output in the same running CLI invocation after compaction and intervening appends', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cli-live-evidence-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd)
	const sessionId = await startConversation(sessions)
	const runId = generateRunId()
	const receipt = `DELTA ${randomUUID()}`
	await writeFile(
		join(cwd, 'manifest.txt'),
		Array.from({ length: 400 }, (_, i) =>
			i === 210 ? receipt : `row ${i}: ${'α🦉 unchanged; '.repeat(30)}`,
		).join('\n'),
	)
	let requests = 0
	let compactionsAfterRead = 0
	let observed = false
	let recovered = ''
	let address:
		| { runId: string; seq: number; part: number; byteOffset?: number; cursor?: string }
		| undefined
	const parse = (content: unknown) => {
		const text = String(content)
		return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
	}
	const provider: LLMProvider = {
		id: 'live-evidence-fixture',
		name: 'Live evidence fixture',
		async *chatStream(params) {
			const step = requests++
			let turn: NonNullable<
				NonNullable<ConstructorParameters<typeof MockLLMProvider>[0]>['turns']
			>[number]
			if (step === 0)
				turn = { toolCalls: [{ id: 'observe-once', name: 'read', args: { path: 'manifest.txt' } }] }
			else if (step === 1) {
				const original = params.messages.find(
					(m) => m.role === 'tool' && m.toolCallId === 'observe-once',
				)
				expect(original).toBeDefined()
				expect(String(original?.content)).not.toContain(receipt)
				await writeFile(join(cwd, 'manifest.txt'), 'Manually replaced; original receipt removed.')
				turn = {
					text: 'Intervening investigation context.',
					toolCalls: [
						{ id: 'intervening-1', name: 'search_tools', args: { query: 'planning task' } },
					],
				}
			} else if (step < 5)
				turn = {
					toolCalls: [
						{
							id: `intervening-${step}`,
							name: 'search_tools',
							args: { query: ['memory', 'read_conversation', 'search_conversation'][step - 2] },
						},
					],
				}
			else if (step === 5)
				turn = {
					usage: { promptTokens: 29000, completionTokens: 100, totalTokens: 29100 },
					toolCalls: [
						{ id: 'search-live', name: 'search_conversation', args: { query: 'DELTA', runId } },
					],
				}
			else {
				const result = params.messages.filter((m) => m.role === 'tool').at(-1)
				const page = parse(result?.content)
				if (result?.role === 'tool' && result.toolCallId.startsWith('search-live')) {
					const match = page.matches.find((match: { text: string }) => match.text.includes(receipt))
					if (!match && page.nextCursor) {
						yield* new MockLLMProvider({
							turns: [
								{
									toolCalls: [
										{
											id: `search-live-${step}`,
											name: 'search_conversation',
											args: { query: 'DELTA', runId, cursor: page.nextCursor },
										},
									],
								},
							],
						}).chatStream(params)
						return
					}
					expect(match?.text, JSON.stringify(page)).toContain(receipt)
					expect(match.retained).toBe('full')
					expect(match.toolName).toBe('read')
					address = { runId, seq: match.seq, part: match.part, byteOffset: match.byteOffset }
					turn = { toolCalls: [{ id: 'recover-live', name: 'read_conversation', args: address }] }
				} else if (page.nextCursor && !page.text) {
					turn = {
						toolCalls: [
							{
								id: `recover-live-${step}`,
								name: 'read_conversation',
								args: { ...address, cursor: page.nextCursor },
							},
						],
					}
				} else {
					recovered = page.text
					expect(recovered).toContain(receipt)
					turn = { text: 'Exact original recovered from the same invocation.' }
				}
			}
			yield* new MockLLMProvider({ turns: [turn] }).chatStream(params)
		},
	}
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot: sessions.root,
		conversationSessions: sessions,
		scope: {
			sessionId,
			topicId: sessions.topicId,
			tenantId: sessions.tenantId,
			projectId: sessions.projectId,
		},
		sandbox: { enabled: false },
		toolLoading: 'deferred',
		compaction: { strategy: 'structured', contextWindowTokens: 32_000 },
		onRunEvent(event) {
			if (event.type === 'tool_completed' && event.toolName === 'read') observed = true
			if (event.type === 'compaction_completed' && observed) compactionsAfterRead++
		},
	})
	opened.push(session)
	const history: Message[] = [
		createUserMessage('Observe the manifest once, then recover the retained receipt.'),
	]
	for (let i = 0; i < 12; i++)
		history.push(
			createUserMessage('Prior unrelated context. '.repeat(50)),
			createAssistantMessage('Earlier investigation. '.repeat(50)),
		)
	history.push(createUserMessage('Recover the original DELTA receipt.'))
	const failures: unknown[] = []
	for await (const event of session.send(history, { runId, permissionMode: 'auto' })) {
		if (event.kind === 'error') failures.push(event)
	}
	expect(recovered, JSON.stringify({ requests, failures })).toContain(receipt)
	expect(compactionsAfterRead).toBeGreaterThan(0)
	const runDir = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	const events = (await readFile(join(runDir, 'transcript.jsonl'), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
	expect(events.filter((e) => e.type === 'tool_executing' && e.toolName === 'read')).toHaveLength(1)
	expect(events.filter((e) => e.type === 'tool_completed' && e.isError)).toHaveLength(0)
	expect(
		events
			.filter((e) => e.type === 'compaction_shed')
			.flatMap((e) => e.messages)
			.some((message) => message.role === 'tool' && message.toolCallId === 'observe-once'),
	).toBe(true)
	expect(await readFile(join(cwd, 'manifest.txt'), 'utf8')).toContain('Manually replaced')
})
