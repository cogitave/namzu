import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { BackendClient, PredictionOptions } from '../client.js'
import { LMStudioProvider } from '../client.js'

/**
 * The driver declared `supportsTools: false` and meant it: tool schemas
 * were never sent, the assistant's own calls were dropped from the
 * history, and each result was folded into a user turn behind a
 * `[tool-result]` marker — so the model read an answer to a question it
 * had no record of asking.
 *
 * Everything here drives the real driver against a scripted backend, so
 * what is asserted is what the driver sends and what it emits, not what a
 * helper returns in isolation.
 */

type Step =
	| { fragment: { content: string; reasoningType?: string } }
	| { fire: (opts: PredictionOptions) => void }
	/**
	 * Fires after the last fragment, while the stream is closing — which is
	 * the only way to exercise the drain that happens once the loop has
	 * exited. A `fire` step is always followed by a fragment, so anything it
	 * queues gets drained by the next pass through the loop and a missing
	 * final drain would go unnoticed.
	 */
	| { fireAtEnd: (opts: PredictionOptions) => void }

function harness(steps: Step[], stats: Record<string, unknown> = { stopReason: 'eosFound' }) {
	const seen: { chat?: { messages: unknown[] }; opts?: PredictionOptions } = {}

	const client: BackendClient = {
		llm: {
			async model() {
				return {
					respond(chat, opts) {
						seen.chat = chat
						seen.opts = opts
						// The real handle is both the fragment stream and the
						// promise of the finished prediction, so the fake is a
						// genuine promise with the iterator hung off it — rather
						// than an object with a hand-rolled `then`, which is both
						// a lint smell and a worse model of the thing.
						return Object.assign(Promise.resolve({ stats }), {
							async *[Symbol.asyncIterator]() {
								for (const step of steps) {
									if ('fireAtEnd' in step) continue
									if ('fire' in step) {
										step.fire(opts)
										// A callback carries no fragment of its own; the
										// driver drains the queue at the next boundary.
										yield { content: '', reasoningType: 'none' as const }
										continue
									}
									yield {
										content: step.fragment.content,
										reasoningType: (step.fragment.reasoningType ?? 'none') as 'none',
									}
								}
								for (const step of steps) {
									if ('fireAtEnd' in step) step.fireAtEnd(opts)
								}
							},
						})
					},
				}
			},
			async listLoaded() {
				return []
			},
		},
	}

	const provider = new LMStudioProvider({ client, model: 'local-model' })
	return { provider, seen }
}

async function drain(
	provider: LMStudioProvider,
	params: Partial<ChatCompletionParams> = {},
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'local-model',
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	} as ChatCompletionParams)) {
		chunks.push(chunk)
	}
	return chunks
}

const TOOLS: ChatCompletionParams['tools'] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read a file',
			parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		},
	},
]

describe('tool schemas on the request', () => {
	it('sends the tools the caller asked for', async () => {
		const { provider, seen } = harness([])
		await drain(provider, { tools: TOOLS })

		expect(seen.opts?.rawTools).toEqual({
			type: 'toolArray',
			tools: [
				{
					type: 'function',
					function: {
						name: 'read_file',
						description: 'Read a file',
						parameters: {
							type: 'object',
							properties: { path: { type: 'string' } },
							required: ['path'],
						},
					},
				},
			],
		})
	})

	it('never rewrites a tool name on the way out', async () => {
		const { provider, seen } = harness([])
		await drain(provider, { tools: TOOLS })
		// The backend rewrites names by default and nothing maps them back
		// when the runtime owns the loop, so a rewritten name would come home
		// unresolvable.
		expect(seen.opts?.toolNaming).toBe('passThrough')
	})

	it('sends nothing when the caller has no tools', async () => {
		const { provider, seen } = harness([])
		await drain(provider)
		expect(seen.opts?.rawTools).toBeUndefined()
	})

	it('turns tools off when the caller forbade them', async () => {
		const { provider, seen } = harness([])
		await drain(provider, { tools: TOOLS, toolChoice: 'none' })
		expect(seen.opts?.rawTools).toEqual({ type: 'none' })
	})

	it('forces a call when the caller required one', async () => {
		const { provider, seen } = harness([])
		await drain(provider, { tools: TOOLS, toolChoice: 'required' })
		expect((seen.opts?.rawTools as { force?: boolean }).force).toBe(true)
	})
})

describe('tool calls off the backend', () => {
	const script: Step[] = [
		{ fire: (o) => o.onToolCallRequestStart?.(0, { toolCallId: 'native-1' }) },
		{ fire: (o) => o.onToolCallRequestNameReceived?.(0, 'read_file') },
		{
			fire: (o) =>
				o.onToolCallRequestEnd?.(0, {
					toolCallRequest: { id: 'native-1', name: 'read_file', arguments: { path: '/etc/hosts' } },
				}),
		},
	]

	it('surfaces the call with a name and stringified arguments', async () => {
		const { provider } = harness(script)
		const calls = (await drain(provider, { tools: TOOLS })).flatMap((c) => c.delta.toolCalls ?? [])

		expect(calls.some((c) => c.function?.name === 'read_file')).toBe(true)
		const withArgs = calls.find((c) => c.function?.arguments !== undefined)
		expect(withArgs?.function?.arguments).toBe('{"path":"/etc/hosts"}')
	})

	it('uses one id for every frame of the same call', async () => {
		const { provider } = harness(script)
		const calls = (await drain(provider, { tools: TOOLS })).flatMap((c) => c.delta.toolCalls ?? [])

		// The runtime binds a result to its call by the id it saw FIRST; a
		// second id part-way through orphans the fragments before it.
		expect(new Set(calls.map((c) => c.id)).size).toBe(1)
		expect(calls[0]?.id).toBe('native-1')
	})

	it('announces the id before the arguments, so no fragment is orphaned', async () => {
		const { provider } = harness(script)
		const calls = (await drain(provider, { tools: TOOLS })).flatMap((c) => c.delta.toolCalls ?? [])

		expect(calls[0]?.id).toBeTruthy()
		expect(calls[0]?.function?.arguments).toBeUndefined()
	})

	it('mints an id when the backend has none', async () => {
		const { provider } = harness([
			{ fire: (o) => o.onToolCallRequestStart?.(0, {}) },
			{
				fire: (o) => o.onToolCallRequestEnd?.(0, { toolCallRequest: { name: 'read_file' } }),
			},
		])
		const calls = (await drain(provider, { tools: TOOLS })).flatMap((c) => c.delta.toolCalls ?? [])
		expect(calls[0]?.id).toBeTruthy()
		expect(new Set(calls.map((c) => c.id)).size).toBe(1)
	})

	it('closes the call so the runtime need not wait for end-of-stream', async () => {
		const { provider } = harness(script)
		const chunks = await drain(provider, { tools: TOOLS })
		const end = chunks.map((c) => c.delta.toolCallEnd).find((e) => e !== undefined)
		expect(end?.id).toBe('native-1')
	})

	it('keeps parallel calls apart', async () => {
		const { provider } = harness([
			{ fire: (o) => o.onToolCallRequestStart?.(0, { toolCallId: 'a' }) },
			{ fire: (o) => o.onToolCallRequestStart?.(1, { toolCallId: 'b' }) },
			{
				fire: (o) =>
					o.onToolCallRequestEnd?.(0, { toolCallRequest: { id: 'a', name: 'read_file' } }),
			},
			{
				fire: (o) =>
					o.onToolCallRequestEnd?.(1, { toolCallRequest: { id: 'b', name: 'write_file' } }),
			},
		])
		const calls = (await drain(provider, { tools: TOOLS })).flatMap((c) => c.delta.toolCalls ?? [])

		expect(new Set(calls.map((c) => c.index))).toEqual(new Set([0, 1]))
		expect(new Set(calls.map((c) => c.id))).toEqual(new Set(['a', 'b']))
	})

	it('reports tool_calls as the finish reason when a call was made', async () => {
		const { provider } = harness(script)
		expect((await drain(provider, { tools: TOOLS })).at(-1)?.finishReason).toBe('tool_calls')
	})

	it('says so when a call could not be parsed rather than going quiet', async () => {
		const { provider } = harness([
			{ fire: (o) => o.onToolCallRequestFailure?.(0, new Error('bad syntax')) },
		])
		const chunks = await drain(provider, { tools: TOOLS })
		// Silence here is indistinguishable from a model that chose not to
		// call anything, and the two need different responses.
		expect(chunks.some((c) => c.error?.includes('bad syntax'))).toBe(true)
	})

	it('emits a call that arrived after the last fragment', async () => {
		// The backend can close out a call as the stream ends; a queue that
		// only drained inside the loop would lose it.
		const { provider } = harness([
			{ fragment: { content: 'thinking about it' } },
			{ fireAtEnd: (o) => o.onToolCallRequestStart?.(0, { toolCallId: 'late' }) },
			{
				fireAtEnd: (o) =>
					o.onToolCallRequestEnd?.(0, { toolCallRequest: { id: 'late', name: 'read_file' } }),
			},
		])
		const chunks = await drain(provider, { tools: TOOLS })
		const calls = chunks.flatMap((c) => c.delta.toolCalls ?? [])
		expect(calls.some((c) => c.id === 'late')).toBe(true)
		expect(chunks.some((c) => c.delta.toolCallEnd?.id === 'late')).toBe(true)
		// …and the run still finishes as a tool turn, not a plain stop.
		expect(chunks.at(-1)?.finishReason).toBe('tool_calls')
	})
})

describe('the conversation, as the backend sees it', () => {
	const conversation: ChatCompletionParams['messages'] = [
		{ role: 'system', content: 'be brief' },
		{ role: 'user', content: 'read it' },
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call-1',
					type: 'function',
					function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' },
				},
			],
		},
		{ role: 'tool', toolCallId: 'call-1', content: '127.0.0.1 localhost' },
	]

	it('keeps the assistant call as a call, not as prose', async () => {
		const { provider, seen } = harness([])
		await drain(provider, { messages: conversation, tools: TOOLS })

		const assistant = seen.chat?.messages[2] as {
			role: string
			content: Array<{ type: string; toolCallRequest?: { name: string; arguments?: unknown } }>
		}
		expect(assistant.role).toBe('assistant')
		expect(assistant.content[0]?.type).toBe('toolCallRequest')
		expect(assistant.content[0]?.toolCallRequest).toEqual({
			id: 'call-1',
			type: 'function',
			name: 'read_file',
			arguments: { path: '/etc/hosts' },
		})
	})

	it('keeps the result as a result, bound to the call it answers', async () => {
		const { provider, seen } = harness([])
		await drain(provider, { messages: conversation, tools: TOOLS })

		const tool = seen.chat?.messages[3] as {
			role: string
			content: Array<{ type: string; content: string; toolCallId?: string }>
		}
		expect(tool.role).toBe('tool')
		expect(tool.content[0]?.type).toBe('toolCallResult')
		expect(tool.content[0]?.toolCallId).toBe('call-1')
		expect(tool.content[0]?.content).toBe('127.0.0.1 localhost')
	})

	it('no longer smuggles a result through a user turn', async () => {
		const { provider, seen } = harness([])
		await drain(provider, { messages: conversation, tools: TOOLS })

		const serialized = JSON.stringify(seen.chat)
		expect(serialized).not.toContain('[tool-result]')
		expect(seen.chat?.messages.filter((m) => (m as { role: string }).role === 'user')).toHaveLength(
			1,
		)
	})

	it('never inlines a base64 payload as text', async () => {
		const PNG = 'iVBORw0KGgoAAAANSUhEUg'
		const { provider, seen } = harness([])
		await drain(provider, {
			messages: [
				{
					role: 'tool',
					toolCallId: 'c',
					content: [
						{ type: 'text', text: 'captured' },
						{ type: 'image', data: PNG, mediaType: 'image/png' },
					],
				},
			],
		})

		const serialized = JSON.stringify(seen.chat)
		expect(serialized).not.toContain(PNG)
		expect(serialized).toContain('captured')
		expect(serialized).toContain('image/png')
	})
})

describe('reasoning', () => {
	it('routes reasoning fragments to reasoning and answer fragments to content', async () => {
		const { provider } = harness([
			{ fragment: { content: '<think>', reasoningType: 'reasoningStartTag' } },
			{ fragment: { content: 'weighing it', reasoningType: 'reasoning' } },
			{ fragment: { content: '</think>', reasoningType: 'reasoningEndTag' } },
			{ fragment: { content: 'the answer' } },
		])
		const chunks = await drain(provider)

		const reasoning = chunks.map((c) => c.delta.reasoning).filter((r) => r !== undefined)
		expect(reasoning[0]?.text).toBe('weighing it')
		expect(reasoning.some((r) => r.done === true)).toBe(true)

		const content = chunks.map((c) => c.delta.content).filter((t) => t !== undefined)
		expect(content.join('')).toBe('the answer')
	})

	it('keeps the tags out of the answer', async () => {
		const { provider } = harness([
			{ fragment: { content: '<think>', reasoningType: 'reasoningStartTag' } },
			{ fragment: { content: 'hm', reasoningType: 'reasoning' } },
			{ fragment: { content: '</think>', reasoningType: 'reasoningEndTag' } },
			{ fragment: { content: 'done' } },
		])
		const chunks = await drain(provider)
		const content = chunks.map((c) => c.delta.content ?? '').join('')
		expect(content).toBe('done')
	})

	it('closes a block the backend never closed', async () => {
		const { provider } = harness([
			{ fragment: { content: 'open forever', reasoningType: 'reasoning' } },
		])
		const chunks = await drain(provider)
		expect(chunks.some((c) => c.delta.reasoning?.done === true)).toBe(true)
	})
})

describe('finish and usage', () => {
	it('reports length when the model ran out of room', async () => {
		const { provider } = harness([], { stopReason: 'maxPredictedTokensReached' })
		expect((await drain(provider)).at(-1)?.finishReason).toBe('length')
	})

	it('carries the token counts back', async () => {
		const { provider } = harness([], {
			stopReason: 'eosFound',
			promptTokensCount: 12,
			predictedTokensCount: 5,
		})
		const usage = (await drain(provider)).at(-1)?.usage
		expect(usage).toMatchObject({ promptTokens: 12, completionTokens: 5, totalTokens: 17 })
	})
})
