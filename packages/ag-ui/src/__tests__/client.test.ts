import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BaseEvent, EventType, HttpAgent, type RunAgentInput } from '@ag-ui/client'
import {
	type ChatCompletionParams,
	InMemoryRunStore,
	MockLLMProvider,
	type QueryParams,
	type StreamChunk,
	ToolRegistry,
	defineTool,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AGUIAdapter, type AGUIRunUI, toNamzuMessages } from '../index.js'

const directories: string[] = []

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
	)
	vi.restoreAllMocks()
})

async function queryParams(
	input: RunAgentInput,
	signal: AbortSignal,
	provider: MockLLMProvider,
	tools = new ToolRegistry(),
): Promise<QueryParams> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-ag-ui-client-'))
	directories.push(workingDirectory)
	return {
		provider,
		tools,
		messages: toNamzuMessages(input.messages),
		signal,
		workingDirectory,
		agentId: 'ag-ui-test',
		agentName: 'AG-UI interoperability test',
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
		runConfig: {
			model: 'mock-model',
			maxIterations: 3,
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxResponseTokens: 256,
		},
		resumeHandler: async () => ({ action: 'continue' }),
		retry: false,
	}
}

function httpClient(adapter: AGUIAdapter, threadId = 'thread-1'): HttpAgent {
	return new HttpAgent({
		url: 'http://namzu.test/agent',
		threadId,
		initialMessages: [{ id: `${threadId}-user`, role: 'user', content: `Hello ${threadId}` }],
		initialState: { count: 0 },
		fetch: (url, init) => adapter.handle(new Request(url, init)),
	})
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('the official AG-UI HttpAgent consumes a real Namzu query', () => {
	it('replaces stale browser history before streaming and keeps model admission explicit', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'Fresh answer', chunkSize: 2 }] })
		let retainedUI: AGUIRunUI | undefined
		const display = [
			{ id: 'authorized-user', role: 'user' as const, content: 'Host-approved display history' },
		]
		const adapter = new AGUIAdapter({
			createQuery: async ({ input, signal, ui }) => {
				retainedUI = ui
				const params = await queryParams(input, signal, provider)
				ui.setInitialMessages(display)
				display[0]!.content = 'Mutation after enqueue'
				return { ...params, messages: [{ role: 'user', content: 'Separate admitted model input' }] }
			},
		})
		const client = httpClient(adapter)
		const events: BaseEvent[] = []
		await client.runAgent(
			{ runId: 'snapshot-run' },
			{
				onEvent: ({ event }) => {
					events.push(event)
					if (event.type === EventType.MESSAGES_SNAPSHOT) {
						expect(provider.requests).toHaveLength(0)
						expect(() => retainedUI?.setInitialMessages([])).toThrow('before it returns')
					}
				},
			},
		)
		expect(events[0]?.type).toBe(EventType.RUN_STARTED)
		expect(events[1]?.type).toBe(EventType.MESSAGES_SNAPSHOT)
		expect(client.messages).toEqual([
			{ id: 'authorized-user', role: 'user', content: 'Host-approved display history' },
			expect.objectContaining({ role: 'assistant', content: 'Fresh answer' }),
		])
		expect(provider.requests[0]?.messages).toContainEqual(
			expect.objectContaining({ content: 'Separate admitted model input' }),
		)
		expect(JSON.stringify(provider.requests)).not.toContain('Host-approved display history')
	})

	it('reconstructs streamed text and forwards the client request to the host', async () => {
		const provider = new MockLLMProvider({
			turns: [{ text: 'Hello from Namzu 🌍', chunkSize: 3 }],
		})
		const inputs: RunAgentInput[] = []
		const adapter = new AGUIAdapter({
			createQuery: async ({ input, signal }) => {
				inputs.push(input)
				return queryParams(input, signal, provider)
			},
		})
		const client = httpClient(adapter)
		const events: BaseEvent[] = []
		const result = await client.runAgent(
			{
				runId: 'run-text',
				context: [{ description: 'Current page', value: '/welcome' }],
				forwardedProps: { locale: 'en' },
			},
			{
				onEvent: ({ event }) => {
					events.push(event)
				},
			},
		)

		expect(inputs).toHaveLength(1)
		expect(inputs[0]).toMatchObject({
			threadId: 'thread-1',
			runId: 'run-text',
			state: { count: 0 },
			context: [{ description: 'Current page', value: '/welcome' }],
			forwardedProps: { locale: 'en' },
		})
		expect(provider.requests[0]?.messages).toContainEqual(
			expect.objectContaining({ role: 'user', content: 'Hello thread-1' }),
		)
		expect(client.messages).toHaveLength(2)
		expect(result.newMessages).toEqual([
			expect.objectContaining({ role: 'assistant', content: 'Hello from Namzu 🌍' }),
		])
		expect(
			events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).length,
		).toBeGreaterThan(1)
		expect(events[0]).toMatchObject({
			type: EventType.RUN_STARTED,
			threadId: 'thread-1',
			runId: 'run-text',
		})
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			threadId: 'thread-1',
			runId: 'run-text',
		})
		expect(client.isRunning).toBe(false)
	})

	it('delivers backend tool arguments, results, shared state, and the next assistant turn', async () => {
		const execute = vi.fn(async ({ text }: { text: string }) => ({ success: true, output: text }))
		const provider = new MockLLMProvider({
			turns: [
				{
					text: 'Checking the echo. ',
					toolCalls: [{ id: 'echo-call', name: 'echo', args: { text: 'pong' }, argChunkSize: 2 }],
				},
				{ text: 'The echo returned pong.', chunkSize: 4 },
			],
		})
		const adapter = new AGUIAdapter({
			createQuery: async ({ input, signal, ui }) => {
				ui.setState({ count: 1, status: 'running' })
				const tools = new ToolRegistry()
				tools.register(
					defineTool({
						name: 'echo',
						description: 'Echo a string',
						inputSchema: z.object({ text: z.string() }),
						category: 'analysis',
						permissions: [],
						readOnly: true,
						destructive: false,
						concurrencySafe: true,
						execute: async (args) => {
							ui.patchState([
								{ op: 'replace', path: '/count', value: 2 },
								{ op: 'replace', path: '/status', value: 'done' },
							])
							ui.custom('echo-observed', { text: args.text })
							return execute(args)
						},
					}),
				)
				return queryParams(input, signal, provider, tools)
			},
		})
		const client = httpClient(adapter)
		const events: BaseEvent[] = []
		const result = await client.runAgent(
			{ runId: 'run-tool' },
			{
				onEvent: ({ event }) => {
					events.push(event)
				},
			},
		)

		expect(execute).toHaveBeenCalledExactlyOnceWith({ text: 'pong' })
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[1]?.messages)).toContain('pong')
		const assistant = result.newMessages.find(
			(message) => message.role === 'assistant' && message.toolCalls?.length,
		)
		expect(assistant).toMatchObject({
			toolCalls: [
				{
					id: 'echo-call',
					type: 'function',
					function: { name: 'echo', arguments: '{"text":"pong"}' },
				},
			],
		})
		expect(result.newMessages).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				toolCallId: 'echo-call',
				content: expect.stringContaining('pong'),
			}),
		)
		expect(result.newMessages.at(-1)).toMatchObject({
			role: 'assistant',
			content: 'The echo returned pong.',
		})
		expect(client.state).toEqual({ count: 2, status: 'done' })
		expect(events).toContainEqual(
			expect.objectContaining({
				type: EventType.STATE_SNAPSHOT,
				snapshot: { count: 1, status: 'running' },
			}),
		)
		expect(events).toContainEqual(expect.objectContaining({ type: EventType.STATE_DELTA }))
		expect(events).toContainEqual(
			expect.objectContaining({
				type: EventType.CUSTOM,
				name: 'echo-observed',
				value: { text: 'pong' },
			}),
		)
		const kinds = events.map((event) => event.type)
		expect(kinds.indexOf(EventType.TOOL_CALL_START)).toBeLessThan(
			kinds.indexOf(EventType.TOOL_CALL_ARGS),
		)
		expect(kinds.indexOf(EventType.TOOL_CALL_ARGS)).toBeLessThan(
			kinds.indexOf(EventType.TOOL_CALL_END),
		)
		expect(kinds.indexOf(EventType.TOOL_CALL_END)).toBeLessThan(
			kinds.indexOf(EventType.TOOL_CALL_RESULT),
		)
		expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
	})

	it('carries a completed tool round into the next run without replaying execution or messages', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'remembered pong' }))
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'remembered-echo', name: 'echo', args: {} }] },
				{ text: 'The echo returned remembered pong.' },
				{ text: 'The earlier echo was remembered pong.' },
			],
		})
		const inputs: RunAgentInput[] = []
		const adapter = new AGUIAdapter({
			createQuery: ({ input, signal }) => {
				inputs.push(input)
				const tools = new ToolRegistry()
				tools.register(
					defineTool({
						name: 'echo',
						description: 'Echo a remembered value',
						inputSchema: z.object({}),
						category: 'analysis',
						permissions: [],
						readOnly: true,
						destructive: false,
						concurrencySafe: true,
						execute,
					}),
				)
				return queryParams(input, signal, provider, tools)
			},
		})
		const client = httpClient(adapter)
		const first = await client.runAgent({ runId: 'conversation-first' })
		const firstMessages = structuredClone(client.messages)
		const followUp = {
			id: 'follow-up-user',
			role: 'user' as const,
			content: 'What did the echo say?',
		}
		client.addMessage(followUp)
		const secondEvents: BaseEvent[] = []
		const second = await client.runAgent(
			{ runId: 'conversation-second' },
			{
				onEvent: ({ event }) => {
					secondEvents.push(event)
				},
			},
		)

		expect(execute).toHaveBeenCalledOnce()
		expect(provider.requests).toHaveLength(3)
		expect(inputs).toHaveLength(2)
		expect(inputs[1]).toMatchObject({
			threadId: 'thread-1',
			runId: 'conversation-second',
			messages: [...firstMessages, followUp],
		})
		expect(provider.requests[2]?.messages).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				toolCallId: 'remembered-echo',
				content: 'remembered pong',
			}),
		)
		expect(second.newMessages).toEqual([
			expect.objectContaining({
				role: 'assistant',
				content: 'The earlier echo was remembered pong.',
			}),
		])
		expect(client.messages).toEqual([...firstMessages, followUp, ...second.newMessages])
		expect(new Set(client.messages.map((message) => message.id)).size).toBe(client.messages.length)
		const toolCalls = client.messages.flatMap((message) =>
			message.role === 'assistant' ? (message.toolCalls ?? []) : [],
		)
		expect(toolCalls.map((call) => call.id)).toEqual(['remembered-echo'])
		expect(second.newMessages[0]?.id).not.toBe(first.newMessages.at(-1)?.id)
		expect(secondEvents.some((event) => event.type === EventType.TOOL_CALL_START)).toBe(false)
		expect(secondEvents.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			threadId: 'thread-1',
			runId: 'conversation-second',
		})
	})

	it('preserves backend tool failure metadata when client history enters the next run', async () => {
		const execute = vi.fn(async () => ({
			success: false,
			output: '',
			error: 'Echo backend is unavailable',
		}))
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'failed-echo', name: 'echo', args: {} }] },
				{ text: 'The echo could not complete.' },
				{ text: 'The previous echo failed because its backend was unavailable.' },
			],
		})
		const adapter = new AGUIAdapter({
			createQuery: ({ input, signal }) => {
				const tools = new ToolRegistry()
				tools.register(
					defineTool({
						name: 'echo',
						description: 'Echo through a backend service',
						inputSchema: z.object({}),
						category: 'analysis',
						permissions: [],
						readOnly: true,
						destructive: false,
						concurrencySafe: true,
						maxRetries: 0,
						execute,
					}),
				)
				return queryParams(input, signal, provider, tools)
			},
		})
		const client = httpClient(adapter)
		const first = await client.runAgent({ runId: 'failed-tool-first' })
		const failedResult = first.newMessages.find((message) => message.role === 'tool')

		expect(failedResult).toMatchObject({
			role: 'tool',
			toolCallId: 'failed-echo',
			metadata: { namzu: { isError: true } },
		})
		client.addMessage({ id: 'failure-follow-up', role: 'user', content: 'Did that echo succeed?' })
		const second = await client.runAgent({ runId: 'failed-tool-second' })

		expect(execute).toHaveBeenCalledOnce()
		expect(provider.requests).toHaveLength(3)
		expect(provider.requests[2]?.messages).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				toolCallId: 'failed-echo',
				isError: true,
			}),
		)
		expect(second.newMessages).toEqual([
			expect.objectContaining({
				role: 'assistant',
				content: 'The previous echo failed because its backend was unavailable.',
			}),
		])
		expect(client.messages.filter((message) => message.role === 'tool')).toEqual([failedResult])
	})

	it('isolates concurrent clients sharing one adapter', async () => {
		const bothStarted = deferred()
		let started = 0
		const adapter = new AGUIAdapter({
			createQuery: async ({ input, signal, ui }) => {
				ui.setState({ owner: input.threadId })
				started++
				if (started === 2) bothStarted.resolve()
				await bothStarted.promise
				return queryParams(
					input,
					signal,
					new MockLLMProvider({
						turns: [{ text: `Reply to ${input.threadId}`, chunkSize: 2 }],
					}),
				)
			},
		})
		const first = httpClient(adapter, 'first')
		const second = httpClient(adapter, 'second')
		const [firstResult, secondResult] = await Promise.all([
			first.runAgent({ runId: 'first-run' }),
			second.runAgent({ runId: 'second-run' }),
		])

		expect(firstResult.newMessages).toEqual([
			expect.objectContaining({ content: 'Reply to first' }),
		])
		expect(secondResult.newMessages).toEqual([
			expect.objectContaining({ content: 'Reply to second' }),
		])
		expect(first.state).toEqual({ owner: 'first' })
		expect(second.state).toEqual({ owner: 'second' })
		expect(first.messages).toHaveLength(2)
		expect(second.messages).toHaveLength(2)
	})

	it('delivers a provider failure as a terminal protocol error', async () => {
		const adapter = new AGUIAdapter({
			createQuery: ({ input, signal }) =>
				queryParams(
					input,
					signal,
					new MockLLMProvider({
						turns: [{ error: { message: 'Model request refused', status: 400 } }],
					}),
				),
		})
		const client = httpClient(adapter)
		const events: BaseEvent[] = []
		const onRunErrorEvent = vi.fn()
		const onRunFailed = vi.fn()
		await client.runAgent(
			{ runId: 'run-error' },
			{
				onEvent: ({ event }) => {
					events.push(event)
				},
				onRunErrorEvent,
				onRunFailed,
			},
		)

		expect(onRunErrorEvent).toHaveBeenCalledOnce()
		expect(onRunFailed).not.toHaveBeenCalled()
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			message: 'Namzu run failed.',
			code: 'NAMZU_RUN_ERROR',
		})
		expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false)
		expect(client.isRunning).toBe(false)
	})

	it('publishes completion only after the final run and message snapshot are persisted', async () => {
		const runStore = new InMemoryRunStore()
		const provider = new MockLLMProvider({ turns: [{ text: 'This answer is persisted.' }] })
		const adapter = new AGUIAdapter({
			createQuery: async ({ input, signal }) => ({
				...(await queryParams(input, signal, provider)),
				runStore,
			}),
		})
		const client = httpClient(adapter)
		const atFinish: { kind: string; status: string | undefined }[] = []
		await client.runAgent(
			{ runId: 'persisted-run' },
			{
				onRunFinishedEvent: async () => {
					atFinish.push({
						kind: (await runStore.readMessages()).kind,
						status: runStore.snapshot().meta?.status,
					})
				},
			},
		)

		expect(atFinish).toEqual([{ kind: 'available', status: 'completed' }])
		expect(runStore.snapshot().meta?.status).toBe('completed')
		expect(await runStore.readMessages()).toMatchObject({
			kind: 'available',
			messages: expect.arrayContaining([
				expect.objectContaining({
					role: 'assistant',
					content: 'This answer is persisted.',
				}),
			]),
		})
	})

	it('reports an oversized final result once after delivering individually bounded text frames', async () => {
		let streamClosed = false
		class TrackedProvider extends MockLLMProvider {
			override async *chatStream(params: ChatCompletionParams): AsyncGenerator<StreamChunk> {
				try {
					yield* super.chatStream(params)
				} finally {
					streamClosed = true
				}
			}
		}
		const text = 'bounded text '.repeat(50)
		const provider = new TrackedProvider({ turns: [{ text, chunkSize: 10 }] })
		const adapter = new AGUIAdapter({
			maxEventBytes: 256,
			createQuery: ({ input, signal }) => queryParams(input, signal, provider),
		})
		const client = httpClient(adapter)
		const events: BaseEvent[] = []
		const onRunErrorEvent = vi.fn()
		const onRunFailed = vi.fn()
		await client.runAgent(
			{ runId: 'oversized-final' },
			{
				onEvent: ({ event }) => {
					events.push(event)
				},
				onRunErrorEvent,
				onRunFailed,
			},
		)

		expect(client.messages.at(-1)).toMatchObject({ role: 'assistant', content: text })
		expect(events.every((event) => Buffer.byteLength(JSON.stringify(event)) <= 256)).toBe(true)
		expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1)
		expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false)
		expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'NAMZU_RUN_ERROR' })
		expect(onRunErrorEvent).toHaveBeenCalledOnce()
		expect(onRunFailed).not.toHaveBeenCalled()
		expect(streamClosed).toBe(true)
		expect(client.isRunning).toBe(false)
	})

	it('rejects an oversized tool start without sending an unmatched end or executing the tool', async () => {
		const releaseArguments = deferred()
		let providerSignal: AbortSignal | undefined
		let streamClosed = false
		const toolCallId = 'tool-'.repeat(100)
		class TrackedProvider extends MockLLMProvider {
			override async *chatStream(params: ChatCompletionParams): AsyncGenerator<StreamChunk> {
				providerSignal = params.signal
				const onAbort = () => releaseArguments.resolve()
				params.signal?.addEventListener('abort', onAbort, { once: true })
				try {
					for await (const chunk of super.chatStream(params)) {
						yield chunk
						if (chunk.delta.toolCalls?.some((call) => call.id === toolCallId)) {
							// The next provider frame is still in flight when the adapter
							// discovers that the call announcement cannot reach its client.
							if (!params.signal?.aborted) await releaseArguments.promise
							if (params.signal?.aborted) return
						}
					}
				} finally {
					params.signal?.removeEventListener('abort', onAbort)
					streamClosed = true
				}
			}
		}
		const execute = vi.fn(async () => ({ success: true, output: 'must not execute' }))
		const provider = new TrackedProvider({
			turns: [{ toolCalls: [{ id: toolCallId, name: 'echo', args: {} }] }],
		})
		const adapter = new AGUIAdapter({
			maxEventBytes: 256,
			createQuery: ({ input, signal }) => {
				const tools = new ToolRegistry()
				tools.register(
					defineTool({
						name: 'echo',
						description: 'Echo a value',
						inputSchema: z.object({}),
						category: 'analysis',
						permissions: [],
						readOnly: true,
						destructive: false,
						concurrencySafe: true,
						execute,
					}),
				)
				return queryParams(input, signal, provider, tools)
			},
		})
		const client = httpClient(adapter)
		const events: BaseEvent[] = []
		const onRunFailed = vi.fn()
		try {
			await client.runAgent(
				{ runId: 'oversized-tool' },
				{
					onEvent: ({ event }) => {
						events.push(event)
					},
					onRunFailed,
				},
			)

			expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1)
			expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'NAMZU_RUN_ERROR' })
			expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false)
			expect(events.some((event) => event.type === EventType.TOOL_CALL_START)).toBe(false)
			expect(events.some((event) => event.type === EventType.TOOL_CALL_END)).toBe(false)
			expect(onRunFailed).not.toHaveBeenCalled()
			expect(execute).not.toHaveBeenCalled()
			expect(providerSignal?.aborted).toBe(true)
			expect(streamClosed).toBe(true)
			expect(client.isRunning).toBe(false)
		} finally {
			releaseArguments.resolve()
		}
	})

	it('propagates HttpAgent cancellation into an active provider stream', async () => {
		const release = deferred()
		const sawText = deferred()
		let providerSignal: AbortSignal | undefined
		let streamClosed = false
		class HeldProvider extends MockLLMProvider {
			override async *chatStream(params: ChatCompletionParams): AsyncGenerator<StreamChunk> {
				providerSignal = params.signal
				const onAbort = () => release.resolve()
				params.signal?.addEventListener('abort', onAbort, { once: true })
				try {
					yield { id: 'held', delta: { content: 'Partial answer' } }
					if (!params.signal?.aborted) await release.promise
				} finally {
					params.signal?.removeEventListener('abort', onAbort)
					streamClosed = true
				}
			}
		}
		const adapter = new AGUIAdapter({
			createQuery: ({ input, signal }) => queryParams(input, signal, new HeldProvider()),
		})
		const client = httpClient(adapter)
		const run = client.runAgent(
			{ runId: 'run-abort' },
			{
				onTextMessageContentEvent: () => {
					sawText.resolve()
				},
			},
		)
		try {
			await sawText.promise
			client.abortRun()
			await run
			expect(providerSignal?.aborted).toBe(true)
			expect(streamClosed).toBe(true)
			expect(client.isRunning).toBe(false)
		} finally {
			release.resolve()
			await run
		}
	})

	it('revokes the UI handle when an unread response request is aborted', async () => {
		const caller = new AbortController()
		const provider = new MockLLMProvider({ turns: [{ text: 'must not start' }] })
		let runUI: AGUIRunUI | undefined
		const adapter = new AGUIAdapter({
			createQuery: ({ input, signal, ui }) => {
				runUI = ui
				return queryParams(input, signal, provider)
			},
		})
		const response = await adapter.handle(
			new Request('http://namzu.test/agent', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				signal: caller.signal,
				body: JSON.stringify({
					threadId: 'unread-thread',
					runId: 'unread-run',
					messages: [{ id: 'unread-user', role: 'user', content: 'Do not start yet' }],
					tools: [],
					context: [],
					state: {},
					forwardedProps: {},
				} satisfies RunAgentInput),
			}),
		)
		try {
			expect(response.status).toBe(200)
			expect(runUI).toBeDefined()
			expect(provider.requests).toHaveLength(0)
			caller.abort()
			expect(() => runUI!.custom('too-late', {})).toThrow('This AG-UI run has ended')
			expect(() => runUI!.setState({ status: 'too-late' })).toThrow('This AG-UI run has ended')
			expect(provider.requests).toHaveLength(0)
		} finally {
			await response.body?.cancel()
		}
	})

	it('cancels an active provider when only the response reader disconnects', async () => {
		const release = deferred()
		const providerHeld = deferred()
		const runStore = new InMemoryRunStore()
		let providerSignal: AbortSignal | undefined
		let streamClosed = false
		class HeldProvider extends MockLLMProvider {
			override async *chatStream(params: ChatCompletionParams): AsyncGenerator<StreamChunk> {
				providerSignal = params.signal
				const onAbort = () => release.resolve()
				params.signal?.addEventListener('abort', onAbort, { once: true })
				try {
					yield { id: 'reader-held', delta: { content: 'Partial answer' } }
					providerHeld.resolve()
					if (!params.signal?.aborted) await release.promise
				} finally {
					params.signal?.removeEventListener('abort', onAbort)
					streamClosed = true
				}
			}
		}
		const adapter = new AGUIAdapter({
			createQuery: async ({ input, signal }) => ({
				...(await queryParams(input, signal, new HeldProvider())),
				runStore,
			}),
		})
		const request = new Request('http://namzu.test/agent', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({
				threadId: 'reader-thread',
				runId: 'reader-run',
				messages: [{ id: 'reader-user', role: 'user', content: 'Keep working' }],
				tools: [],
				context: [],
				state: {},
				forwardedProps: {},
			} satisfies RunAgentInput),
		})
		const response = await adapter.handle(request)
		expect(response.status).toBe(200)
		const reader = response.body!.getReader()
		const consuming = (async () => {
			while (!(await reader.read()).done) {
				/* Keep pulling until the response is canceled. */
			}
		})()
		try {
			await providerHeld.promise
			expect(providerSignal?.aborted).toBe(false)
			expect(streamClosed).toBe(false)
			await reader.cancel('The HTTP consumer disconnected')
			await consuming
			expect(request.signal.aborted).toBe(false)
			expect(providerSignal?.aborted).toBe(true)
			expect(streamClosed).toBe(true)
			expect(runStore.snapshot().meta?.status).toBe('cancelled')
			expect(await runStore.readMessages()).toMatchObject({ kind: 'available' })
		} finally {
			release.resolve()
			await reader.cancel()
			await consuming
			reader.releaseLock()
		}
	})
})
