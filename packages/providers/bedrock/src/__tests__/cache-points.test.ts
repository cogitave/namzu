import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { BedrockProvider } from '../client.js'

/**
 * Caching was documented and never requested.
 *
 * The driver read `cacheReadInputTokenCount` and `cacheWriteInputTokenCount`
 * correctly and emitted no cache point, so the counters reported zero
 * honestly and a caller who had read the provider page was paying full
 * input price on every turn with nothing to tell them apart from a workload
 * caching cannot help.
 *
 * These tests assert the marker reaches the REQUEST. A green usage
 * assertion cannot do that job — the counters were always parsed correctly,
 * so they were green throughout the period when nothing was cached.
 */

const CACHED_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
const OTHER_VENDOR_MODEL = 'amazon.nova-pro-v1:0'

/** Every `cachePoint` anywhere in the request, however deeply nested. */
function countCachePoints(value: unknown): number {
	if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countCachePoints(v), 0)
	if (value === null || typeof value !== 'object') return 0

	const entries = Object.entries(value as Record<string, unknown>)
	return entries.reduce((n, [key, v]) => n + (key === 'cachePoint' ? 1 : countCachePoints(v)), 0)
}

/** Drive one request and hand back what the AWS client was actually given. */
async function capture(
	params: Partial<ChatCompletionParams> = {},
): Promise<Record<string, unknown>> {
	const provider = new BedrockProvider({ region: 'us-east-1' })
	let commandInput: Record<string, unknown> | undefined
	;(provider as unknown as { client: unknown }).client = {
		send: async (command: { input: Record<string, unknown> }) => {
			commandInput = command.input
			return { $metadata: { requestId: 'request-test' }, stream: (async function* () {})() }
		},
	}

	const request = {
		model: CACHED_MODEL,
		messages: [{ role: 'user', content: 'go' }],
		...params,
	} as ChatCompletionParams

	for await (const _chunk of provider.chatStream(request)) {
		// Drain the empty test stream.
	}

	if (!commandInput) throw new Error('the provider never called the client')
	return commandInput
}

const TOOLS: ChatCompletionParams['tools'] = [
	{
		type: 'function',
		function: { name: 'edit', description: 'Edit', parameters: { type: 'object' } },
	},
]

const SYSTEM_STATIC_THEN_DYNAMIC: ChatCompletionParams['messages'] = [
	{ role: 'system', content: 'static instructions', cacheHint: 'cache' },
	{ role: 'system', content: 'per-run state', cacheHint: 'ephemeral' },
	{ role: 'user', content: 'go' },
]

const CACHE_POINT = { cachePoint: { type: 'default' } }

describe('a cache point reaches the request when caching is requested', () => {
	it('marks the tail of the tool schemas', async () => {
		const input = await capture({
			cacheControl: { type: 'auto' },
			tools: TOOLS,
		})

		const tools = (input.toolConfig as { tools: unknown[] }).tools
		expect(tools).toHaveLength(2)
		expect(tools[1]).toEqual(CACHE_POINT)
		// The schema itself is untouched — the marker is appended beside it,
		// not folded into it.
		expect(tools[0]).toMatchObject({ toolSpec: { name: 'edit' } })
	})

	it('marks the tail of the STATIC system text, not the end of the array', async () => {
		const input = await capture({
			cacheControl: { type: 'auto' },
			messages: SYSTEM_STATIC_THEN_DYNAMIC,
		})

		// Position, not presence. A marker after `per-run state` would put
		// text that changes every run inside the cached prefix: every read
		// would miss and every write would be paid for, which looks from
		// outside like a cache that never warms up.
		expect(input.system).toEqual([
			{ text: 'static instructions' },
			CACHE_POINT,
			{ text: 'per-run state' },
		])
	})

	it('marks the last content block of the last message', async () => {
		const input = await capture({
			cacheControl: { type: 'auto' },
			messages: [
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'second' },
				{ role: 'user', content: 'third' },
			],
		})

		const messages = input.messages as { content: unknown[] }[]
		expect(messages).toHaveLength(3)
		expect(messages[2]?.content).toEqual([{ text: 'third' }, CACHE_POINT])
		// Only the last one. Every earlier message is already inside that
		// prefix, and the wire allows a small fixed number of these.
		expect(countCachePoints(messages[0])).toBe(0)
		expect(countCachePoints(messages[1])).toBe(0)
	})

	it('spends exactly three, which is what the provider page promises', async () => {
		const input = await capture({
			cacheControl: { type: 'auto' },
			tools: TOOLS,
			messages: SYSTEM_STATIC_THEN_DYNAMIC,
		})

		expect(countCachePoints(input)).toBe(3)
	})

	it('omits the system point when there is no static text to anchor it to', async () => {
		const input = await capture({
			cacheControl: { type: 'auto' },
			tools: TOOLS,
			messages: [
				{ role: 'system', content: 'per-run state', cacheHint: 'ephemeral' },
				{ role: 'user', content: 'go' },
			],
		})

		expect(countCachePoints(input.system)).toBe(0)
		// …while the other two still land, so an absent anchor costs one
		// breakpoint rather than all of them.
		expect(countCachePoints(input)).toBe(2)
	})
})

describe('a cache point is absent when caching is not requested', () => {
	it('sends nothing at all when the caller set no cacheControl', async () => {
		const input = await capture({ tools: TOOLS, messages: SYSTEM_STATIC_THEN_DYNAMIC })

		expect(countCachePoints(input)).toBe(0)
	})

	it('leaves a model outside the gate byte-for-byte as it was', async () => {
		// Prompt caching is a property of the models on this wire, not of the
		// wire, so the gate follows the model. The assertion is equality with
		// the uncached request rather than "no cache point": a gate that
		// suppressed the marker while perturbing anything else would be a
		// silent change to a request that works today.
		const withCaching = await capture({
			model: OTHER_VENDOR_MODEL,
			cacheControl: { type: 'auto' },
			tools: TOOLS,
			messages: SYSTEM_STATIC_THEN_DYNAMIC,
		})
		const without = await capture({
			model: OTHER_VENDOR_MODEL,
			tools: TOOLS,
			messages: SYSTEM_STATIC_THEN_DYNAMIC,
		})

		expect(withCaching).toEqual(without)
		expect(countCachePoints(withCaching)).toBe(0)
	})

	it('does not mark the placeholder tools minted from history', async () => {
		// These are specs reconstructed to keep the wire happy when history
		// references a tool the caller no longer passes — their description
		// is the literal `(completed)`. Caching them would pin a prefix that
		// is not the caller's tool set.
		const input = await capture({
			cacheControl: { type: 'auto' },
			messages: [
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'edit', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_1', content: 'done' },
			],
		})

		const tools = (input.toolConfig as { tools: unknown[] }).tools
		expect(tools).toHaveLength(1)
		expect(countCachePoints(input.toolConfig)).toBe(0)
	})
})

/**
 * The runtime appends request-only context after the history: runtime
 * context user messages of kind `step-context` carrying the working-memory
 * slot, a `context` prompt contribution, `PrepareStepResult.context`. It
 * changes from one request to the next, so a point after it would cache a
 * prefix the next request never repeats — every pinned request a miss.
 */
describe('the message cache point ends the history, before request-only context', () => {
	const stepContext = (content: string) =>
		({
			role: 'user',
			content,
			source: { type: 'runtime-context', kind: 'step-context' },
		}) as ChatCompletionParams['messages'][number]

	it('precedes the step-context and stays put when that context changes', async () => {
		const history: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'first' },
			{ role: 'assistant', content: 'second' },
			{ role: 'user', content: 'third' },
		]
		const one = await capture({
			cacheControl: { type: 'auto' },
			messages: [...history, stepContext('PIN ONE'), stepContext('SNAPSHOT ONE')],
		})
		const two = await capture({
			cacheControl: { type: 'auto' },
			messages: [...history, stepContext('PIN TWO')],
		})

		const messages = one.messages as { role: string; content: unknown[] }[]
		// Folded into the last user turn (see the alternation tests), with the
		// point between the history's block and the context's.
		expect(messages).toHaveLength(3)
		expect(messages[2]?.content).toEqual([
			{ text: 'third' },
			CACHE_POINT,
			{ text: 'PIN ONE' },
			{ text: 'SNAPSHOT ONE' },
		])
		expect(countCachePoints(one.messages)).toBe(1)

		// Everything up to and including the point is byte-identical across
		// two requests whose context differs: the prefix the next one reads.
		const cut = (input: Record<string, unknown>) => {
			const all = input.messages as { content: { cachePoint?: unknown }[] }[]
			const last = all[all.length - 1]?.content ?? []
			const at = last.findIndex((block) => block.cachePoint !== undefined)
			return JSON.stringify([...all.slice(0, -1), last.slice(0, at + 1)])
		}
		expect(cut(one)).toBe(cut(two))
	})

	it('falls on the tool results when the context follows them', async () => {
		const input = await capture({
			cacheControl: { type: 'auto' },
			messages: [
				{ role: 'user', content: 'go' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'edit', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_1', content: 'done' },
				stepContext('PIN'),
			],
			tools: TOOLS,
		})

		const messages = input.messages as { role: string; content: Record<string, unknown>[] }[]
		expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
		const last = messages[2]?.content ?? []
		expect(Object.keys(last[0] ?? {})).toEqual(['toolResult'])
		expect(last[1]).toEqual(CACHE_POINT)
		expect(last[2]).toEqual({ text: 'PIN' })
	})

	it('sets no message point when nothing precedes the context', async () => {
		const input = await capture({
			cacheControl: { type: 'auto' },
			messages: [stepContext('ONLY CONTEXT')],
		})
		expect(countCachePoints(input.messages)).toBe(0)
	})
})

describe('consecutive same-role messages are merged for Converse', () => {
	it('folds adjacent user turns into one, blocks in order', async () => {
		const input = await capture({
			messages: [
				{ role: 'user', content: 'a' },
				{ role: 'user', content: 'b' },
				{ role: 'assistant', content: 'c' },
				{ role: 'assistant', content: 'd' },
				{ role: 'user', content: 'e' },
			],
		})

		expect(input.messages).toEqual([
			{ role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
			{ role: 'assistant', content: [{ text: 'c' }, { text: 'd' }] },
			{ role: 'user', content: [{ text: 'e' }] },
		])
	})

	it('alternates on every request the runtime sends after a tool call', async () => {
		const input = await capture({
			messages: [
				{ role: 'user', content: 'go' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'edit', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_1', content: 'done' },
				{
					role: 'user',
					content: 'context',
					source: { type: 'runtime-context', kind: 'step-context' },
				} as ChatCompletionParams['messages'][number],
			],
			tools: TOOLS,
		})

		const roles = (input.messages as { role: string }[]).map((m) => m.role)
		for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1])
	})
})
