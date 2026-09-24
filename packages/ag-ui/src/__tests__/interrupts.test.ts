import { getEventListeners } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type BaseEvent,
	EventType,
	HttpAgent,
	type Interrupt,
	type RunAgentInput,
	buildResumeArray,
} from '@ag-ui/client'
import {
	type ChatCompletionParams,
	InMemorySessionCheckpointStore,
	InMemorySessionLog,
	type LLMProvider,
	MOCK_CAPABILITIES,
	MockLLMProvider,
	type MockTurn,
	ProviderError,
	type QueryParams,
	type ResumeHandler,
	type StreamChunk,
	ToolRegistry,
	buildAskUserQuestionTool,
	createReviewHandler,
	defineTool,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
	AGUIAdapter,
	type AGUIAdapterOptions,
	type AGUITurnContext,
	InMemoryAGUIInterruptStore,
} from '../index.js'
import { questionInterrupt } from '../interrupts.js'

const directories: string[] = []

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
	)
	vi.restoreAllMocks()
})

/** A host's durable view of one thread: its session log and the scope it was authorized under. */
interface Thread {
	readonly log: InMemorySessionLog
	readonly scope: Pick<QueryParams, 'sessionId' | 'topicId' | 'projectId' | 'tenantId'>
}

interface Harness {
	readonly adapter: AGUIAdapter
	readonly provider: MockLLMProvider
	readonly contexts: AGUITurnContext[]
	readonly threads: Map<string, Thread>
	thread(threadId: string): Thread
	client(threadId?: string): HttpAgent
}

interface HarnessOptions {
	readonly turns: MockTurn[]
	/** Wraps the scripted provider, for faults the script cannot express. */
	readonly provider?: (scripted: MockLLMProvider) => LLMProvider
	readonly tools?: (context: AGUITurnContext, registry: ToolRegistry) => void
	readonly resumeHandler?: (context: AGUITurnContext, registry: ToolRegistry) => ResumeHandler
	readonly withoutLog?: boolean
	readonly params?: (context: AGUITurnContext) => Partial<QueryParams>
	readonly adapter?: Partial<AGUIAdapterOptions>
	/** The host's thread state, shared with another harness: the same host, another process. */
	readonly threads?: Map<string, Thread>
}

/**
 * A host as the docs describe one: it authorizes the thread, keeps the
 * thread's session log and scope, builds the tools for each request, and
 * sends every decision that needs a person to the client.
 */
function harness(options: HarnessOptions): Harness {
	const provider = new MockLLMProvider({ turns: options.turns })
	const serving = options.provider?.(provider) ?? provider
	const threads = options.threads ?? new Map<string, Thread>()
	const contexts: AGUITurnContext[] = []
	const thread = (threadId: string): Thread => {
		let found = threads.get(threadId)
		if (!found) {
			const sessionId = generateSessionId()
			found = {
				log: new InMemorySessionLog({ sessionId }),
				scope: {
					sessionId,
					topicId: generateTopicId(),
					projectId: generateProjectId(),
					tenantId: generateTenantId(),
				},
			}
			threads.set(threadId, found)
		}
		return found
	}
	const adapter = new AGUIAdapter({
		...options.adapter,
		createQuery: async (context) => {
			contexts.push(context)
			const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-ag-ui-interrupts-'))
			directories.push(workingDirectory)
			const { log, scope } = thread(context.input.threadId)
			const tools = new ToolRegistry()
			options.tools?.(context, tools)
			return {
				provider: serving,
				tools,
				messages: context.input.messages
					.filter((message) => message.role === 'user')
					.map((message) => ({ role: 'user' as const, content: String(message.content) })),
				signal: context.signal,
				workingDirectory,
				agentId: 'ag-ui-interrupts',
				agentName: 'AG-UI interrupt test',
				...scope,
				...(options.withoutLog ? {} : { sessionLog: log }),
				turnConfig: {
					model: 'mock-model',
					maxIterations: 4,
					timeoutMs: 20_000,
					tokenBudget: 100_000,
					maxResponseTokens: 256,
				},
				resumeHandler: options.resumeHandler?.(context, tools) ?? context.interrupts.resumeHandler,
				retry: false,
				...options.params?.(context),
			}
		},
	})
	return {
		adapter,
		provider,
		contexts,
		threads,
		thread,
		client: (threadId = 'thread-1') =>
			new HttpAgent({
				url: 'http://namzu.test/agent',
				threadId,
				initialMessages: [{ id: `${threadId}-user`, role: 'user', content: 'Please go ahead.' }],
				fetch: (url, init) => adapter.handle(new Request(url, init)),
			}),
	}
}

function deployTool(executed: unknown[]) {
	return defineTool({
		name: 'deploy',
		description: 'Deploy the service.',
		inputSchema: z.object({ target: z.string() }),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: true,
		concurrencySafe: false,
		execute: async (input) => {
			executed.push(input)
			return { success: true, output: `deployed to ${input.target}` }
		},
	})
}

function readTool(reads: string[]) {
	return defineTool({
		name: 'read_status',
		description: 'Read the deployment status.',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => {
			reads.push('status')
			return { success: true, output: 'green' }
		},
	})
}

const deployCall = (target = 'production', id = 'call_deploy'): MockTurn => ({
	toolCalls: [{ id, name: 'deploy', args: { target } }],
	finishReason: 'tool_calls',
})

/** Every event of one run of the official client, with the run's outcome. */
async function runClient(
	client: HttpAgent,
	parameters: Parameters<HttpAgent['runAgent']>[0] = {},
): Promise<{ events: BaseEvent[]; interrupts: Interrupt[]; failed?: Error }> {
	const events: BaseEvent[] = []
	let interrupts: Interrupt[] = []
	try {
		await client.runAgent(parameters, {
			onEvent: ({ event }) => {
				events.push(event)
			},
			onRunFinishedEvent: (params) => {
				if (params.outcome === 'interrupt') interrupts = params.interrupts
			},
		})
		return { events, interrupts }
	} catch (error) {
		return { events, interrupts, failed: error as Error }
	}
}

/** Drive the adapter directly, for refusals the official client would stop before sending. */
async function runRaw(
	adapter: AGUIAdapter,
	input: Partial<RunAgentInput> & Pick<RunAgentInput, 'threadId'>,
): Promise<BaseEvent[]> {
	const events: BaseEvent[] = []
	for await (const event of adapter.run({
		runId: `raw-${Math.random()}`,
		messages: [{ id: 'raw-user', role: 'user', content: 'Something new.' }],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
		...input,
	})) {
		events.push(event)
	}
	return events
}

async function turnsOf(log: InMemorySessionLog): Promise<string[]> {
	const { entries } = await log.readAll()
	return [
		...new Set(
			entries
				.map(({ record }) => ('turnId' in record ? String(record.turnId) : undefined))
				.filter((turnId): turnId is string => turnId !== undefined),
		),
	]
}

describe('a tool call that needs approval', () => {
	it('ends the run as an interrupt and runs the call once the client approves', async () => {
		const executed: unknown[] = []
		const h = harness({
			turns: [deployCall(), { text: 'Deployed.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
		})
		const client = h.client()
		const first = await runClient(client)
		expect(first.failed).toBeUndefined()
		expect(executed).toEqual([])
		expect(first.interrupts).toHaveLength(1)
		const [interrupt] = first.interrupts as [Interrupt]
		expect(interrupt).toMatchObject({
			reason: 'tool_call',
			toolCallId: 'call_deploy',
			message: 'Approve the deploy call?',
			responseSchema: { required: ['approved'] },
			metadata: {
				namzu: { kind: 'tool_approval', toolName: 'deploy', input: { target: 'production' } },
			},
		})
		// The interrupt id is the host's, never a native id.
		expect(interrupt.id).not.toContain('call_deploy')
		expect(first.events.map((event) => event.type)).toEqual(
			expect.arrayContaining([EventType.TOOL_CALL_START, EventType.TOOL_CALL_END]),
		)
		expect(first.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: 'interrupt' },
		})
		expect(JSON.stringify(first.events)).not.toContain('NAMZU_TURN_PAUSED')
		expect(client.pendingInterrupts).toHaveLength(1)

		const second = await runClient(client, {
			resume: buildResumeArray(client.pendingInterrupts, {
				[interrupt.id]: { status: 'resolved', payload: { approved: true } },
			}),
		})
		expect(second.failed).toBeUndefined()
		expect(executed).toEqual([{ target: 'production' }])
		// The call is not announced again: its result arrives against the original id.
		expect(second.events.filter((event) => event.type === EventType.TOOL_CALL_START)).toEqual([])
		expect(second.events).toContainEqual(
			expect.objectContaining({
				type: EventType.TOOL_CALL_RESULT,
				toolCallId: 'call_deploy',
				content: 'deployed to production',
			}),
		)
		expect(second.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: 'success' },
			result: 'Deployed.',
		})
		expect(client.pendingInterrupts).toEqual([])
		// One native turn across both runs: the answer continued the checkpoint.
		expect(await turnsOf(h.thread('thread-1').log)).toHaveLength(1)
		expect(h.contexts[1]?.continuation).toMatchObject({ kind: 'resume' })
	})

	it('refuses the call when the client denies it, with the client’s reason for the model', async () => {
		const executed: unknown[] = []
		const h = harness({
			turns: [deployCall(), { text: 'Understood, not deploying.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
		})
		const client = h.client()
		const first = await runClient(client)
		const [interrupt] = first.interrupts as [Interrupt]
		const second = await runClient(client, {
			resume: [
				{
					interruptId: interrupt.id,
					status: 'resolved',
					payload: { approved: false, reason: 'Not during the freeze.' },
				},
			],
		})
		expect(second.failed).toBeUndefined()
		expect(executed).toEqual([])
		expect(second.events).toContainEqual(
			expect.objectContaining({
				type: EventType.TOOL_CALL_RESULT,
				toolCallId: 'call_deploy',
				content: expect.stringContaining('Not during the freeze.'),
			}),
		)
		expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('Not during the freeze.')
		expect(second.events.at(-1)).toMatchObject({ result: 'Understood, not deploying.' })
	})

	it('runs the call with the arguments the client edited', async () => {
		const executed: unknown[] = []
		const h = harness({
			turns: [deployCall(), { text: 'Deployed to staging.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
		})
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		const second = await runClient(client, {
			resume: [
				{
					interruptId: interrupt.id,
					status: 'resolved',
					payload: { approved: true, editedArgs: { target: 'staging' } },
				},
			],
		})
		expect(second.failed).toBeUndefined()
		expect(executed).toEqual([{ target: 'staging' }])
	})

	it('treats a cancelled approval as a refusal', async () => {
		const executed: unknown[] = []
		const h = harness({
			turns: [deployCall(), { text: 'Skipped.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
		})
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		const second = await runClient(client, {
			resume: [{ interruptId: interrupt.id, status: 'cancelled' }],
		})
		expect(second.failed).toBeUndefined()
		expect(executed).toEqual([])
		expect(second.events.at(-1)).toMatchObject({ result: 'Skipped.' })
	})

	it('asks only about the calls the review policy puts to a person', async () => {
		const executed: unknown[] = []
		const reads: string[] = []
		const h = harness({
			turns: [
				{
					toolCalls: [
						{ id: 'call_read', name: 'read_status', args: {} },
						{ id: 'call_deploy', name: 'deploy', args: { target: 'production' } },
					],
					finishReason: 'tool_calls',
				},
				{ text: 'Status green, deployed.' },
			],
			tools: (_context, tools) => {
				tools.register(readTool(reads))
				tools.register(deployTool(executed))
			},
			resumeHandler: (context, tools) =>
				createReviewHandler({ mode: 'prompt', prompt: context.interrupts.prompt, registry: tools }),
		})
		const client = h.client()
		const first = await runClient(client)
		expect(first.interrupts.map((interrupt) => interrupt.toolCallId)).toEqual(['call_deploy'])
		expect(reads).toEqual([])
		const second = await runClient(client, {
			resume: [
				{
					interruptId: (first.interrupts[0] as Interrupt).id,
					status: 'resolved',
					payload: { approved: true },
				},
			],
		})
		expect(second.failed).toBeUndefined()
		expect(reads).toEqual(['status'])
		expect(executed).toEqual([{ target: 'production' }])
	})

	it('runs a batch that needs nobody without interrupting', async () => {
		const reads: string[] = []
		const h = harness({
			turns: [
				{
					toolCalls: [{ id: 'call_read', name: 'read_status', args: {} }],
					finishReason: 'tool_calls',
				},
				{ text: 'Green.' },
			],
			tools: (_context, tools) => tools.register(readTool(reads)),
		})
		const run = await runClient(h.client())
		expect(run.failed).toBeUndefined()
		expect(run.interrupts).toEqual([])
		expect(reads).toEqual(['status'])
	})
})

describe('what a resume may not do', () => {
	async function interrupted(
		threadId = 'thread-1',
		turns: MockTurn[] = [deployCall(), { text: 'Done.' }],
	) {
		const executed: unknown[] = []
		const h = harness({
			turns,
			tools: (_context, tools) => tools.register(deployTool(executed)),
		})
		const client = h.client(threadId)
		const first = await runClient(client)
		return { h, client, executed, interrupts: first.interrupts }
	}

	it('refuses a second answer to the same interrupt, and runs the call once', async () => {
		const { h, client, executed, interrupts } = await interrupted()
		const resume = [
			{
				interruptId: (interrupts[0] as Interrupt).id,
				status: 'resolved' as const,
				payload: { approved: true },
			},
		]
		await runClient(client, { resume })
		const again = await runRaw(h.adapter, { threadId: 'thread-1', resume })
		expect(again.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR])
		expect(again.at(-1)).toMatchObject({ code: 'AGUI_INTERRUPT_RESOLVED' })
		expect(executed).toHaveLength(1)
	})

	it('lets exactly one of two concurrent answers through', async () => {
		const { h, executed, interrupts } = await interrupted()
		const resume = [
			{
				interruptId: (interrupts[0] as Interrupt).id,
				status: 'resolved' as const,
				payload: { approved: true },
			},
		]
		const [a, b] = await Promise.all([
			runRaw(h.adapter, { threadId: 'thread-1', resume }),
			runRaw(h.adapter, { threadId: 'thread-1', resume }),
		])
		const codes = [a.at(-1), b.at(-1)].map((event) =>
			event?.type === EventType.RUN_ERROR ? (event as { code?: string }).code : 'finished',
		)
		expect(codes.sort()).toEqual(['AGUI_INTERRUPT_RESOLVED', 'finished'])
		expect(executed).toHaveLength(1)
	})

	it('does not answer an interrupt from another thread, and leaves it answerable on its own', async () => {
		const { h, client, executed, interrupts } = await interrupted('thread-a')
		const id = (interrupts[0] as Interrupt).id
		const foreign = await runRaw(h.adapter, {
			threadId: 'thread-b',
			resume: [{ interruptId: id, status: 'resolved', payload: { approved: true } }],
		})
		expect(foreign.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'AGUI_INTERRUPT_UNKNOWN',
		})
		expect(executed).toEqual([])
		const own = await runClient(client, {
			resume: [{ interruptId: id, status: 'resolved', payload: { approved: true } }],
		})
		expect(own.failed).toBeUndefined()
		expect(executed).toHaveLength(1)
	})

	it('refuses an id nobody raised', async () => {
		const { h } = await interrupted()
		const events = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: 'made-up', status: 'resolved', payload: { approved: true } }],
		})
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'AGUI_INTERRUPT_UNKNOWN',
		})
		expect(h.contexts).toHaveLength(1)
	})

	it('refuses a payload in the wrong shape, and keeps the interrupt open', async () => {
		const { h, client, executed, interrupts } = await interrupted()
		const id = (interrupts[0] as Interrupt).id
		const bad = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: id, status: 'resolved', payload: { approved: 'yes' } }],
		})
		expect(bad.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'AGUI_RESUME_PAYLOAD_INVALID',
		})
		const good = await runClient(client, {
			resume: [{ interruptId: id, status: 'resolved', payload: { approved: true } }],
		})
		expect(good.failed).toBeUndefined()
		expect(executed).toHaveLength(1)
	})

	it('refuses a resume that leaves one of the run’s interrupts unanswered', async () => {
		const { h, executed, interrupts } = await interrupted('thread-1', [
			{
				toolCalls: [
					{ id: 'call_a', name: 'deploy', args: { target: 'a' } },
					{ id: 'call_b', name: 'deploy', args: { target: 'b' } },
				],
				finishReason: 'tool_calls',
			},
			{ text: 'Both.' },
		])
		expect(interrupts.map((interrupt) => interrupt.toolCallId)).toEqual(['call_a', 'call_b'])
		const partial = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [
				{
					interruptId: (interrupts[0] as Interrupt).id,
					status: 'resolved',
					payload: { approved: true },
				},
			],
		})
		expect(partial.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'AGUI_RESUME_INCOMPLETE',
		})
		expect(executed).toEqual([])
		const mixed = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [
				{
					interruptId: (interrupts[0] as Interrupt).id,
					status: 'resolved',
					payload: { approved: true },
				},
				{
					interruptId: (interrupts[1] as Interrupt).id,
					status: 'resolved',
					payload: { approved: false },
				},
			],
		})
		expect(mixed.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, result: 'Both.' })
		expect(executed).toEqual([{ target: 'a' }])
	})

	it('sends the open interrupts again when new input arrives instead of an answer', async () => {
		const { h, client, executed, interrupts } = await interrupted()
		// A client that lost them — a reload, a dropped connection — gets the
		// same interrupts under the same ids, and nothing runs.
		const events = await runRaw(h.adapter, { threadId: 'thread-1' })
		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_FINISHED,
		])
		expect(events.at(-1)).toMatchObject({
			outcome: {
				type: 'interrupt',
				interrupts: [expect.objectContaining({ id: interrupts[0]?.id })],
			},
		})
		expect(executed).toEqual([])
		expect(h.provider.requests).toHaveLength(1)
		// The host still authenticated the request.
		expect(h.contexts).toHaveLength(2)
		const answered = await runClient(client, {
			resume: [
				{
					interruptId: (interrupts[0] as Interrupt).id,
					status: 'resolved',
					payload: { approved: true },
				},
			],
		})
		expect(answered.failed).toBeUndefined()
		expect(executed).toHaveLength(1)
	})

	it('keeps one session’s interrupts from another session that reuses the thread id', async () => {
		const store = new InMemoryAGUIInterruptStore()
		const executed: unknown[] = []
		const tenantA = harness({
			turns: [deployCall(), { text: 'A done.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
			adapter: { interrupts: { store } },
		})
		expect((await runClient(tenantA.client('shared'))).interrupts).toHaveLength(1)
		// Another tenant's host resolves the same client string to its own
		// session: A's open interrupt is neither shown to it nor in its way.
		const tenantB = harness({
			turns: [{ text: 'B answered.' }],
			adapter: { interrupts: { store } },
		})
		const events = await runRaw(tenantB.adapter, { threadId: 'shared' })
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, result: 'B answered.' })
		expect(JSON.stringify(events)).not.toContain('deploy')
		expect(executed).toEqual([])
	})

	it('reopens the interrupts when the kernel refuses the answer for a reason that can pass', async () => {
		const executed: unknown[] = []
		const h = harness({
			turns: [deployCall(), { text: 'Deployed after all.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
		})
		const [interrupt] = (await runClient(h.client())).interrupts as [Interrupt]
		// Another worker holds the session: the kernel refuses to resume it.
		const log = h.thread('thread-1').log
		const lease = await log.claim({ holder: 'another-worker', ttlMs: 60_000 })
		const resume = [
			{ interruptId: interrupt.id, status: 'resolved' as const, payload: { approved: true } },
		]
		const refused = await runRaw(h.adapter, { threadId: 'thread-1', resume })
		expect(refused.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'AGUI_RESUME_FAILED' })
		expect(executed).toEqual([])
		if (lease) await log.release(lease)
		const again = await runRaw(h.adapter, { threadId: 'thread-1', resume })
		expect(again.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			result: 'Deployed after all.',
		})
		expect(executed).toHaveLength(1)
	})

	it('closes a paused turn whose checkpoint is gone, and frees the thread', async () => {
		const executed: unknown[] = []
		const h = harness({
			turns: [deployCall(), { text: 'Fresh.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
			params: (context) =>
				context.continuation
					? {
							// A store that never saw this turn's checkpoints.
							checkpointStore: new InMemorySessionCheckpointStore({
								log: h.thread('thread-1').log as unknown as ConstructorParameters<
									typeof InMemorySessionCheckpointStore
								>[0]['log'],
							}),
						}
					: {},
		})
		const [interrupt] = (await runClient(h.client())).interrupts as [Interrupt]
		const events = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }],
		})
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'AGUI_INTERRUPT_STALE' })
		expect(executed).toEqual([])
		const next = await runRaw(h.adapter, { threadId: 'thread-1' })
		expect(next.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, result: 'Fresh.' })
	})

	it('puts every call of a batch to the client when the host’s own policy paused it', async () => {
		const executed: unknown[] = []
		const reads: string[] = []
		const h = harness({
			turns: [
				{
					toolCalls: [
						{ id: 'call_read', name: 'read_status', args: {} },
						{ id: 'call_deploy', name: 'deploy', args: { target: 'production' } },
					],
					finishReason: 'tool_calls',
				},
				{ text: 'Only the read ran.' },
			],
			tools: (_context, tools) => {
				tools.register(readTool(reads))
				tools.register(deployTool(executed))
			},
			resumeHandler: () => async (request) =>
				request.type === 'tool_review'
					? { action: 'pause', reason: 'The operator reviews every call.' }
					: { action: 'continue' },
		})
		const client = h.client()
		const first = await runClient(client)
		expect(first.interrupts.map((interrupt) => interrupt.toolCallId)).toEqual([
			'call_read',
			'call_deploy',
		])
		const [read, deploy] = first.interrupts as [Interrupt, Interrupt]
		const second = await runClient(client, {
			resume: [
				{ interruptId: read.id, status: 'resolved', payload: { approved: true } },
				{ interruptId: deploy.id, status: 'resolved', payload: { approved: false } },
			],
		})
		expect(second.failed).toBeUndefined()
		expect(reads).toEqual(['status'])
		expect(executed).toEqual([])
	})

	it('lets go of a long-lived host signal when the turn ends', async () => {
		const shutdown = new AbortController()
		const h = harness({
			turns: [{ text: 'One.' }],
			params: () => ({ signal: shutdown.signal }),
		})
		for (const thread of ['a', 'b', 'c']) {
			const events = await runRaw(h.adapter, { threadId: thread })
			expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
		}
		expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(0)
	})

	it('refuses to resume a paused turn without the session log it lives in', async () => {
		const h = harness({
			turns: [deployCall(), { text: 'Done.' }],
			tools: (_context, tools) => tools.register(deployTool([])),
			params: (context) => (context.continuation ? { sessionLog: undefined } : {}),
		})
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		const events = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }],
		})
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'AGUI_RESUME_UNAVAILABLE',
		})
	})

	it('refuses an answer once its interrupt has expired, but accepts its cancellation', async () => {
		const executed: unknown[] = []
		const h = harness({
			turns: [deployCall(), { text: 'Not deployed.' }],
			tools: (_context, tools) => tools.register(deployTool(executed)),
			adapter: { interrupts: { ttlMs: 20 } },
		})
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		expect(interrupt.expiresAt).toEqual(expect.any(String))
		await new Promise((resolve) => setTimeout(resolve, 40))
		const late = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }],
		})
		expect(late.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'AGUI_INTERRUPT_EXPIRED' })
		const cancelled = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'cancelled' }],
		})
		expect(cancelled.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			result: 'Not deployed.',
		})
		expect(executed).toEqual([])
	})
})

describe('a question the model asks the user', () => {
	const askTurn: MockTurn = {
		toolCalls: [
			{
				id: 'call_ask',
				name: 'ask_user_question',
				args: {
					question: 'Which environment?',
					options: [{ label: 'Staging (Recommended)' }, { label: 'Production' }],
				},
			},
		],
		finishReason: 'tool_calls',
	}

	function questionHarness(
		turns: MockTurn[],
		adapter?: Partial<AGUIAdapterOptions>,
		threads?: Map<string, Thread>,
	) {
		return harness({
			turns,
			adapter,
			...(threads ? { threads } : {}),
			tools: (context, tools) =>
				tools.register(
					buildAskUserQuestionTool({ resumeHandler: context.interrupts.resumeHandler }),
				),
		})
	}

	it('becomes an input_required interrupt whose answer the asking tool receives', async () => {
		const h = questionHarness([askTurn, { text: 'Production it is.' }])
		const client = h.client()
		const first = await runClient(client)
		expect(first.failed).toBeUndefined()
		expect(first.interrupts).toHaveLength(1)
		const [interrupt] = first.interrupts as [Interrupt]
		expect(interrupt).toMatchObject({
			reason: 'input_required',
			toolCallId: 'call_ask',
			message: 'Which environment?',
			metadata: {
				namzu: {
					kind: 'question',
					options: [
						{ id: 'opt_1', label: 'Staging', recommended: true },
						{ id: 'opt_2', label: 'Production' },
					],
					multiSelect: false,
					allowFreeText: true,
				},
			},
		})
		expect(interrupt.responseSchema).toMatchObject({
			properties: { selected: { items: { enum: ['opt_1', 'opt_2'] }, maxItems: 1 } },
		})
		// The question waits inside its tool, so the model was called once.
		expect(h.provider.requests).toHaveLength(1)
		const second = await runClient(client, {
			resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { selected: ['opt_2'] } }],
		})
		expect(second.failed).toBeUndefined()
		expect(second.events.filter((event) => event.type === EventType.TOOL_CALL_START)).toEqual([])
		expect(second.events).toContainEqual(
			expect.objectContaining({
				type: EventType.TOOL_CALL_RESULT,
				toolCallId: 'call_ask',
				content: expect.stringContaining('Production'),
			}),
		)
		expect(second.events.at(-1)).toMatchObject({ result: 'Production it is.' })
		expect(await turnsOf(h.thread('thread-1').log)).toHaveLength(1)
	})

	it('accepts an answer in the user’s own words', async () => {
		const h = questionHarness([askTurn, { text: 'Noted.' }])
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		const second = await runClient(client, {
			resume: [
				{ interruptId: interrupt.id, status: 'resolved', payload: { text: 'the canary pool' } },
			],
		})
		expect(second.failed).toBeUndefined()
		expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('the canary pool')
	})

	it('reports a cancelled question as unanswered, never as a choice', async () => {
		const h = questionHarness([askTurn, { text: 'Proceeding carefully.' }])
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		const second = await runClient(client, {
			resume: [{ interruptId: interrupt.id, status: 'cancelled' }],
		})
		expect(second.failed).toBeUndefined()
		const toolResult = JSON.stringify(h.provider.requests[1]?.messages)
		expect(toolResult).toContain('did not answer')
		expect(toolResult).not.toContain('Staging (Recommended)"')
	})

	it('offers no option list for a question without options', () => {
		const record = {
			id: 'int',
			kind: 'question' as const,
			status: 'open' as const,
			delivery: 'live' as const,
			threadId: 't',
			runId: 'r',
			group: 'g',
			sessionId: 's',
			turnId: 'u',
			checkpointId: 'c',
			createdAt: 0,
		}
		const interrupt = questionInterrupt(
			record,
			{ questionId: 'q', question: 'Why?', options: [], multiSelect: false, allowFreeText: true },
			undefined,
		)
		expect(interrupt.responseSchema).toEqual({
			type: 'object',
			properties: { text: expect.objectContaining({ type: 'string' }) },
		})
	})

	it('refuses an option the question did not offer', async () => {
		const h = questionHarness([askTurn, { text: 'x' }])
		const [interrupt] = (await runClient(h.client())).interrupts as [Interrupt]
		const events = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { selected: ['opt_9'] } }],
		})
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'AGUI_RESUME_PAYLOAD_INVALID',
		})
	})

	it('keeps waiting after the connection that raised it closes', async () => {
		const h = questionHarness([askTurn, { text: 'Staging.' }])
		const connection = new AbortController()
		const response = await h.adapter.handle(
			new Request('http://namzu.test/agent', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				signal: connection.signal,
				body: JSON.stringify({
					threadId: 'thread-1',
					runId: 'run-1',
					messages: [{ id: 'user', role: 'user', content: 'Deploy.' }],
					tools: [],
					context: [],
					state: {},
					forwardedProps: {},
				} satisfies RunAgentInput),
			}),
		)
		const text = await response.text()
		expect(text).toContain('"input_required"')
		// A server closes the request once the response has ended; that is not
		// the client abandoning the question.
		connection.abort()
		const id = /"id":"([0-9a-f-]{36})","reason":"input_required"/.exec(text)?.[1] as string
		const events = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: id, status: 'resolved', payload: { selected: ['opt_1'] } }],
		})
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, result: 'Staging.' })
	})

	it('expires unanswered, closes the turn and frees the thread', async () => {
		const h = questionHarness([askTurn, { text: 'A fresh start.' }], { interrupts: { ttlMs: 30 } })
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		expect(Date.parse(interrupt.expiresAt as string)).toBeLessThanOrEqual(Date.now() + 30)
		await new Promise((resolve) => setTimeout(resolve, 80))
		const late = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { selected: ['opt_1'] } }],
		})
		expect(late.at(-1)).toMatchObject({ code: 'AGUI_INTERRUPT_EXPIRED' })
		// The waiting turn was cancelled, so the thread takes new input.
		await vi.waitFor(async () => {
			const events = await runRaw(h.adapter, { threadId: 'thread-1' })
			expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
		})
	})

	it('is stale in a process that does not hold the waiting turn', async () => {
		const store = new InMemoryAGUIInterruptStore()
		const first = questionHarness([askTurn, { text: 'x' }], { interrupts: { store } })
		const [interrupt] = (await runClient(first.client())).interrupts as [Interrupt]
		// The same host, restarted: its sessions survive, the waiting turn did not.
		const restarted = questionHarness([{ text: 'x' }], { interrupts: { store } }, first.threads)
		const events = await runRaw(restarted.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { selected: ['opt_1'] } }],
		})
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'AGUI_INTERRUPT_STALE' })
		// A stale interrupt no longer blocks the thread's store.
		expect(await store.listOpen('thread-1')).toEqual([])
	})

	it('expires with the turn’s own time limit', async () => {
		const h = harness({
			turns: [askTurn, { text: 'x' }],
			tools: (context, tools) =>
				tools.register(
					buildAskUserQuestionTool({ resumeHandler: context.interrupts.resumeHandler }),
				),
			params: () => ({
				turnConfig: {
					model: 'mock-model',
					maxIterations: 4,
					timeoutMs: 3_000,
					tokenBudget: 100_000,
					maxResponseTokens: 256,
				},
			}),
		})
		const started = Date.now()
		const [interrupt] = (await runClient(h.client())).interrupts as [Interrupt]
		// Past the limit the kernel stops the turn before the model reads the
		// answer, so the interrupt does not outlive it.
		expect(Date.parse(interrupt.expiresAt as string) - started).toBeLessThanOrEqual(3_000)
	})
})

describe('a tool that hands the turn to a person', () => {
	function handoffTool(calls: string[]) {
		return defineTool({
			name: 'open_desktop',
			description: 'Open the remote desktop.',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => {
				calls.push('open_desktop')
				return {
					success: false,
					output: 'The page is a sign-in form.',
					error: 'sign-in required',
					handoff: {
						kind: 'human-required' as const,
						reason: 'Sign in to example.test on the desktop, then continue.',
						detail: { origin: 'https://example.test' },
					},
				}
			},
		})
	}

	it('interrupts for the person, and continues the same turn when they are done', async () => {
		const calls: string[] = []
		const h = harness({
			turns: [
				{
					toolCalls: [{ id: 'call_desk', name: 'open_desktop', args: {} }],
					finishReason: 'tool_calls',
				},
				{ text: 'Signed in; carrying on.' },
			],
			tools: (_context, tools) => tools.register(handoffTool(calls)),
		})
		const client = h.client()
		const first = await runClient(client)
		expect(first.interrupts).toEqual([
			expect.objectContaining({
				reason: 'namzu:handoff',
				message: 'Sign in to example.test on the desktop, then continue.',
				metadata: { namzu: { kind: 'handoff', detail: { origin: 'https://example.test' } } },
			}),
		])
		expect(h.provider.requests).toHaveLength(1)
		const second = await runClient(client, {
			resume: [{ interruptId: (first.interrupts[0] as Interrupt).id, status: 'resolved' }],
		})
		expect(second.failed).toBeUndefined()
		expect(second.events.at(-1)).toMatchObject({ result: 'Signed in; carrying on.' })
		expect(calls).toEqual(['open_desktop'])
		expect(await turnsOf(h.thread('thread-1').log)).toHaveLength(1)
	})

	it('closes the turn when the person cancels, and the thread takes new input', async () => {
		const h = harness({
			turns: [
				{
					toolCalls: [{ id: 'call_desk', name: 'open_desktop', args: {} }],
					finishReason: 'tool_calls',
				},
				{ text: 'A new question answered.' },
			],
			tools: (_context, tools) => tools.register(handoffTool([])),
		})
		const client = h.client()
		const [interrupt] = (await runClient(client)).interrupts as [Interrupt]
		const cancelled = await runRaw(h.adapter, {
			threadId: 'thread-1',
			resume: [{ interruptId: interrupt.id, status: 'cancelled' }],
		})
		expect(cancelled.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'NAMZU_TURN_ABANDONED',
		})
		const next = await runRaw(h.adapter, { threadId: 'thread-1' })
		expect(next.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			result: 'A new question answered.',
		})
		expect(await turnsOf(h.thread('thread-1').log)).toHaveLength(2)
	})
})

describe('a tool the client declares', () => {
	const pickColor = {
		name: 'pick_color',
		description: 'Ask the user to pick a color in the page.',
		parameters: {
			type: 'object',
			properties: { palette: { type: 'string' } },
			required: ['palette'],
		},
	}
	const pickTurn: MockTurn = {
		toolCalls: [{ id: 'call_pick', name: 'pick_color', args: { palette: 'warm' } }],
		finishReason: 'tool_calls',
	}

	function frontendHarness(turns: MockTurn[], adapter: Partial<AGUIAdapterOptions> = {}) {
		return harness({
			turns,
			adapter: { frontendTools: { allow: ['pick_color'] }, ...adapter },
			tools: (context, tools) => {
				for (const tool of context.frontendTools) tools.register(tool)
			},
		})
	}

	it('is called by the model, answered by the client, and read by the model', async () => {
		const h = frontendHarness([pickTurn, { text: 'Teal is a fine choice.' }])
		const client = h.client()
		const first = await runClient(client, { tools: [pickColor] })
		expect(first.failed).toBeUndefined()
		// A frontend call ends a completed run, never an interrupted one.
		expect(first.interrupts).toEqual([])
		expect(first.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: 'success' },
		})
		expect(first.events.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toEqual([])
		const call = client.messages
			.flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []) : []))
			.find((toolCall) => toolCall.function.name === 'pick_color')
		expect(call).toMatchObject({ id: 'call_pick', function: { arguments: '{"palette":"warm"}' } })
		expect(h.provider.requests[0]?.tools?.map((tool) => tool.function.name)).toContain('pick_color')

		client.addMessage({
			id: 'tool-result-1',
			role: 'tool',
			toolCallId: 'call_pick',
			content: 'teal',
		})
		const second = await runClient(client, { tools: [pickColor] })
		expect(second.failed).toBeUndefined()
		expect(second.events.at(-1)).toMatchObject({ result: 'Teal is a fine choice.' })
		// The client already holds the result; the server does not echo it.
		expect(second.events.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toEqual([])
		expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('teal')
		expect(client.messages.filter((message) => message.role === 'tool')).toHaveLength(1)
		expect(h.contexts[1]?.continuation).toMatchObject({ kind: 'tool-results' })
		expect(await turnsOf(h.thread('thread-1').log)).toHaveLength(1)
	})

	it('passes a client-reported failure to the model as a failed result', async () => {
		const h = frontendHarness([pickTurn, { text: 'The picker failed.' }])
		const client = h.client()
		await runClient(client, { tools: [pickColor] })
		client.addMessage({
			id: 'tool-result-1',
			role: 'tool',
			toolCallId: 'call_pick',
			content: 'picker crashed',
			error: 'picker crashed',
		})
		const second = await runClient(client, { tools: [pickColor] })
		expect(second.failed).toBeUndefined()
		const sent = h.provider.requests[1]?.messages.find((message) => message.role === 'tool')
		expect(sent).toMatchObject({ isError: true })
	})

	it('frees the thread when a pending call lapses, even before its timer runs', async () => {
		const h = frontendHarness([pickTurn, { text: 'Moved on.' }], { interrupts: { ttlMs: 50 } })
		await runClient(h.client(), { tools: [pickColor] })
		// Hold the event loop past the deadline, so new input notices the lapse
		// before the expiry timer can.
		const until = Date.now() + 120
		while (Date.now() < until) {
			/* busy */
		}
		const events = await runRaw(h.adapter, { threadId: 'thread-1', tools: [pickColor] })
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, result: 'Moved on.' })
		const later = await runRaw(h.adapter, { threadId: 'thread-1', tools: [pickColor] })
		expect(later.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
	})

	it('refuses new input that does not carry the pending result', async () => {
		const h = frontendHarness([pickTurn, { text: 'x' }])
		await runClient(h.client(), { tools: [pickColor] })
		const events = await runRaw(h.adapter, { threadId: 'thread-1', tools: [pickColor] })
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'AGUI_TOOL_RESULT_REQUIRED',
		})
	})

	it('never reaches the client when the authorization gate denies it', async () => {
		const h = harness({
			turns: [pickTurn, { text: 'Not allowed to ask.' }],
			adapter: { frontendTools: { allow: ['pick_color'] } },
			tools: (context, tools) => {
				for (const tool of context.frontendTools) tools.register(tool)
			},
			params: () => ({
				authorizationGate: {
					enabled: true,
					rules: [{ type: 'deny_by_name', toolNames: ['pick_color'] }],
					allowReadOnlyTools: false,
					denyDangerousPatterns: false,
					logDecisions: false,
				},
			}),
		})
		const run = await runClient(h.client(), { tools: [pickColor] })
		expect(run.failed).toBeUndefined()
		expect(run.events.at(-1)).toMatchObject({ result: 'Not allowed to ask.' })
		expect(run.events).toContainEqual(
			expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, toolCallId: 'call_pick' }),
		)
		expect(await runRaw(h.adapter, { threadId: 'thread-1' })).toContainEqual(
			expect.objectContaining({ type: EventType.RUN_FINISHED }),
		)
	})

	it('is refused unless the host admits it', async () => {
		const closed = harness({ turns: [{ text: 'x' }] })
		const response = await closed.adapter.handle(
			new Request('http://namzu.test/agent', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					threadId: 't',
					runId: 'r',
					messages: [],
					tools: [pickColor],
					context: [],
					state: {},
					forwardedProps: {},
				} satisfies RunAgentInput),
			}),
		)
		expect(response.status).toBe(422)
		expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_FRONTEND_TOOLS' } })

		const listed = frontendHarness([{ text: 'x' }])
		const other = { ...pickColor, name: 'delete_everything' }
		const refused = await listed.adapter.handle(
			new Request('http://namzu.test/agent', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					threadId: 't',
					runId: 'r',
					messages: [],
					tools: [pickColor, other],
					context: [],
					state: {},
					forwardedProps: {},
				} satisfies RunAgentInput),
			}),
		)
		expect(refused.status).toBe(422)

		const omitting = frontendHarness([{ text: 'Only the picker.' }], {
			frontendTools: { allow: ['pick_color'], unlisted: 'omit' },
		})
		const run = await runClient(omitting.client(), { tools: [pickColor, other] })
		expect(run.failed).toBeUndefined()
		expect(omitting.contexts[0]?.frontendTools.map((tool) => tool.name)).toEqual(['pick_color'])
		expect(omitting.provider.requests[0]?.tools?.map((tool) => tool.function.name)).not.toContain(
			'delete_everything',
		)
	})
})

describe('other pauses', () => {
	it('interrupts on a provider fault the turn can be resumed from', async () => {
		let failures = 1
		const h = harness({
			turns: [{ text: 'Recovered.' }],
			provider: (scripted) => ({
				id: 'flaky',
				name: 'Flaky',
				capabilities: MOCK_CAPABILITIES,
				async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
					if (failures-- > 0)
						throw new ProviderError({
							code: 'rate_limit',
							message: 'the provider said 429',
							providerId: 'flaky',
							status: 429,
						})
					yield* scripted.chatStream(params)
				},
			}),
		})
		const client = h.client()
		const first = await runClient(client)
		expect(first.interrupts).toEqual([
			expect.objectContaining({
				reason: 'namzu:paused',
				metadata: { namzu: { kind: 'paused', retryable: true } },
			}),
		])
		const second = await runClient(client, {
			resume: [{ interruptId: (first.interrupts[0] as Interrupt).id, status: 'resolved' }],
		})
		expect(second.failed).toBeUndefined()
		expect(second.events.at(-1)).toMatchObject({ result: 'Recovered.' })
		expect(await turnsOf(h.thread('thread-1').log)).toHaveLength(1)
	})

	it('asks for confirmation when the host’s own policy pauses the turn', async () => {
		const reads: string[] = []
		let paused = false
		const h = harness({
			turns: [
				{
					toolCalls: [{ id: 'call_read', name: 'read_status', args: {} }],
					finishReason: 'tool_calls',
				},
				{ text: 'Continued after the checkpoint.' },
			],
			tools: (_context, tools) => tools.register(readTool(reads)),
			// A host policy that approves tools and stops once at the iteration
			// cadence, the way an operator asks "carry on?".
			resumeHandler: () => async (request) => {
				if (request.type === 'iteration_checkpoint' && !paused) {
					paused = true
					return { action: 'pause', reason: 'Checkpoint for the operator.' }
				}
				return request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' }
			},
		})
		const client = h.client()
		const first = await runClient(client)
		expect(first.interrupts).toEqual([
			expect.objectContaining({
				reason: 'confirmation',
				message: 'Continue after iteration 1?',
				responseSchema: expect.objectContaining({ required: ['approved'] }),
				metadata: { namzu: expect.objectContaining({ kind: 'checkpoint', iteration: 1 }) },
			}),
		])
		const second = await runClient(client, {
			resume: [
				{
					interruptId: (first.interrupts[0] as Interrupt).id,
					status: 'resolved',
					payload: { approved: true },
				},
			],
		})
		expect(second.failed).toBeUndefined()
		expect(second.events.at(-1)).toMatchObject({ result: 'Continued after the checkpoint.' })
		expect(reads).toEqual(['status'])
	})
})

describe('state across an interrupt', () => {
	it('snapshots the turn’s state at the boundary and keeps publishing after the answer', async () => {
		const h = harness({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_ask',
							name: 'ask_user_question',
							args: { question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] },
						},
					],
					finishReason: 'tool_calls',
				},
				{ toolCalls: [{ id: 'call_mark', name: 'mark', args: {} }], finishReason: 'tool_calls' },
				{ text: 'Marked.' },
			],
			tools: (context, tools) => {
				context.ui.setState({ step: 'asking' })
				tools.register(
					buildAskUserQuestionTool({ resumeHandler: context.interrupts.resumeHandler }),
				)
				tools.register(
					defineTool({
						name: 'mark',
						description: 'Mark progress.',
						inputSchema: z.object({}),
						category: 'custom',
						permissions: [],
						readOnly: true,
						destructive: false,
						concurrencySafe: true,
						execute: async () => {
							context.ui.patchState([{ op: 'replace', path: '/step', value: 'marked' }])
							return { success: true, output: 'ok' }
						},
					}),
				)
			},
		})
		const client = h.client()
		const first = await runClient(client)
		const boundary = [...first.events]
			.reverse()
			.find((event) => event.type === EventType.STATE_SNAPSHOT)
		expect(boundary).toMatchObject({ snapshot: { step: 'asking' } })
		expect(first.events.indexOf(boundary as BaseEvent)).toBeLessThan(first.events.length - 1)
		const second = await runClient(client, {
			resume: [
				{
					interruptId: (first.interrupts[0] as Interrupt).id,
					status: 'resolved',
					payload: { selected: ['opt_1'] },
				},
			],
		})
		expect(second.failed).toBeUndefined()
		expect(second.events).toContainEqual(expect.objectContaining({ type: EventType.STATE_DELTA }))
		expect(client.state).toEqual({ step: 'marked' })
	})
})
