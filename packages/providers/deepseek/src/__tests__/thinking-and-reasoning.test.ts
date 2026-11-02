import type { ChatCompletionParams, ProviderRoute, StreamChunk } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	DeepSeekProvider,
	assertEffortUnsupported,
	assertSamplingUsable,
	resolveDeepSeekEffort,
	thinkingEnabled,
	toDeepSeekMessages,
} from '../client.js'

const ROUTE = {
	providerId: 'deepseek',
	model: 'deepseek-v4-flash',
	chainIndex: 0,
} as const

function replayState(reasoningContent: string, route: ProviderRoute = ROUTE) {
	return {
		kind: 'namzu-deepseek-reasoning',
		version: 1,
		route,
		reasoningContent,
	}
}

/**
 * The four behaviours that are this driver's whole reason to be a separate
 * package. Everything else is the OpenAI Chat Completions wire, which the
 * conformance suite already covers.
 *
 * Every claim below was measured against the live API on 2026-08-17 before it
 * was coded, and the measurements are quoted where a reader would otherwise
 * assume the documentation.
 */

function params(over: Partial<ChatCompletionParams> = {}): ChatCompletionParams {
	return {
		model: 'deepseek-v4-flash',
		messages: [],
		...over,
	} as ChatCompletionParams
}

describe('thinking is ON unless the caller says otherwise', () => {
	it('treats an absent thinking config as enabled', () => {
		// The vendor's default, measured: a request with no `thinking` key
		// comes back carrying `reasoning_content`. Reading absence as "off"
		// would make every rule keyed on this apply to explicit callers only
		// and miss the common case entirely.
		expect(thinkingEnabled(undefined)).toBe(true)
	})

	it('treats each of the vendor’s three variants correctly', () => {
		// `adaptive`, `enabled`, `disabled` are the vendor's own variants —
		// named by its 400 when sent a fourth — and the same three the SDK's
		// `ThinkingConfig` declares. Only `disabled` turns thinking off.
		expect(thinkingEnabled({ type: 'adaptive' })).toBe(true)
		expect(thinkingEnabled({ type: 'enabled' })).toBe(true)
		expect(thinkingEnabled({ type: 'disabled' })).toBe(false)
	})
})

describe('a sampling parameter thinking mode would discard', () => {
	it('is refused rather than sent, with thinking on', () => {
		// Measured: the vendor returns 200 for `temperature` in thinking mode
		// and applies it to nothing. So a caller who pinned `temperature: 0`
		// for reproducibility would get sampling, no error, and no way to find
		// out.
		expect(() => assertSamplingUsable(params({ temperature: 0 }), 'refuse')).toThrow(
			/ignored in thinking mode/,
		)
	})

	it('names every offending field, not just the first', () => {
		// A message naming one field sends the caller round the loop once per
		// parameter.
		expect(() =>
			assertSamplingUsable(params({ temperature: 0, topP: 1, presencePenalty: 0.5 }), 'refuse'),
		).toThrow(/temperature, topP, presencePenalty/)
	})

	it('allows them once thinking is off, because then they are honoured', () => {
		expect(() =>
			assertSamplingUsable(params({ temperature: 0, thinking: { type: 'disabled' } }), 'refuse'),
		).not.toThrow()
	})

	it("allows them under 'ignore', which is the documented opt-out", () => {
		expect(() => assertSamplingUsable(params({ temperature: 0 }), 'ignore')).not.toThrow()
	})

	it('says nothing when no sampling parameter was set', () => {
		// The guard has to be silent on the ordinary path, or thinking-mode
		// runs become unusable — thinking is on by default.
		expect(() => assertSamplingUsable(params(), 'refuse')).not.toThrow()
	})
})

describe('reasoning effort', () => {
	it('publishes none plus the vendor levels, and high as the default', () => {
		const provider = new DeepSeekProvider({ apiKey: 'test-key' })

		expect(provider.reasoningEffortLevelsFor('deepseek-flash')).toEqual([
			'none',
			'low',
			'high',
			'max',
		])
		expect(provider.reasoningEffortDefaultFor('deepseek-flash')).toBe('high')
	})

	it('follows the models endpoint once it has been read', async () => {
		const provider = new DeepSeekProvider({ apiKey: 'test-key' })
		;(provider as unknown as { client: { models: { list: unknown } } }).client.models.list =
			async () => ({
				data: [{ id: 'm1', effort: { supported_levels: ['low', 'high'], default_level: 'low' } }],
			})
		await provider.resolveContextWindow('m1')
		expect(provider.reasoningEffortLevelsFor('m1')).toEqual(['none', 'low', 'high'])
		expect(provider.reasoningEffortDefaultFor('m1')).toBe('low')
	})

	it.each([
		['minimal', 'low', true],
		['low', 'low', false],
		['medium', 'high', true],
		['high', 'high', false],
		['xhigh', 'high', true],
		['max', 'max', false],
		['ultra', 'max', true],
	] as const)('maps %s to the vendor level %s', (asked, sent, mapped) => {
		expect(resolveDeepSeekEffort(asked)).toEqual({ level: sent, mapped })
	})

	it('uses the nearest offered level, the lower on a tie, when the menu lacks the target', () => {
		expect(resolveDeepSeekEffort('max', ['low', 'high'])).toEqual({ level: 'high', mapped: true })
		expect(resolveDeepSeekEffort('ultra', ['low', 'high'])).toEqual({ level: 'high', mapped: true })
		expect(resolveDeepSeekEffort('medium', ['low', 'max'])).toEqual({ level: 'low', mapped: true })
		expect(resolveDeepSeekEffort('none', ['low'])).toEqual({ level: 'none', mapped: false })
	})

	it('treats none as thinking off', () => {
		expect(thinkingEnabled(undefined, 'none')).toBe(false)
		expect(thinkingEnabled(undefined, 'max')).toBe(true)
	})
})

describe('reasoning effort on the wire', () => {
	async function sent(over: Partial<ChatCompletionParams>): Promise<Record<string, any>> {
		let body: Record<string, any> | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				body = JSON.parse(String(init?.body))
				return new Response(JSON.stringify({ error: { message: 'fixture refusal' } }), {
					status: 400,
					headers: { 'content-type': 'application/json' },
				})
			}),
		)
		const provider = new DeepSeekProvider({ apiKey: 'fixture', maxRetries: 0 })
		await expect(async () => {
			for await (const _ of provider.chatStream(
				params({ messages: [{ role: 'user', content: 'x' }], ...over }),
			)) {
			}
		}).rejects.toBeDefined()
		return body as Record<string, any>
	}
	afterEach(() => vi.unstubAllGlobals())

	it('sends max as reasoning_effort beside the model', async () => {
		const body = await sent({ effort: 'max' })
		expect(body.reasoning_effort).toBe('max')
		expect(body.thinking).toBeUndefined()
	})

	it('sends the vendor level a wider one maps to', async () => {
		expect((await sent({ effort: 'xhigh' })).reasoning_effort).toBe('high')
		expect((await sent({ effort: 'minimal' })).reasoning_effort).toBe('low')
	})

	it('turns thinking off for none, with no level', async () => {
		const body = await sent({ effort: 'none' })
		expect(body.thinking).toEqual({ type: 'disabled' })
		expect(body.reasoning_effort).toBeUndefined()
	})

	it('lets an explicit disabled thinking win over a level', async () => {
		const body = await sent({ effort: 'high', thinking: { type: 'disabled' } })
		expect(body.thinking).toEqual({ type: 'disabled' })
		expect(body.reasoning_effort).toBeUndefined()
	})

	it('sends neither field when the caller said nothing', async () => {
		const body = await sent({})
		expect(body.thinking).toBeUndefined()
		expect(body.reasoning_effort).toBeUndefined()
	})

	it('honours sampling parameters once none turned thinking off', async () => {
		const body = await sent({ effort: 'none', temperature: 0 })
		expect(body.temperature).toBe(0)
	})

	it('still refuses sampling parameters while an effort keeps thinking on', async () => {
		await expect(async () => {
			for await (const _ of new DeepSeekProvider({ apiKey: 'fixture' }).chatStream(
				params({ effort: 'high', temperature: 0 }),
			)) {
			}
		}).rejects.toThrow(/thinking mode/)
	})
})

describe('the retired effort guard', () => {
	it('stays exported and unchanged for callers that imported it', () => {
		expect(() => assertEffortUnsupported(params({ effort: 'high' }))).toThrow(/not carried/)
		expect(() => assertEffortUnsupported(params())).not.toThrow()
	})
})

describe('reasoning blocks are replayed onto the wire', () => {
	it('puts an assistant turn’s reasoning back as reasoning_content', () => {
		// The vendor requires this whenever tool calls are in play, and ignores
		// it otherwise, so it is done unconditionally. `AssistantMessage.
		// reasoning` already promises "replayed verbatim"; this is where that
		// promise is kept for this wire.
		const wire = toDeepSeekMessages(
			[
				{ role: 'user', content: 'hi' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{
							id: 'call_1',
							type: 'function',
							function: { name: 'f', arguments: '{}' },
						},
					],
					reasoning: [
						{ type: 'thinking', text: 'first ' },
						{ type: 'thinking', text: 'second' },
					],
					source: {
						type: 'model',
						...ROUTE,
						replayState: replayState('first second'),
					},
				},
			] as ChatCompletionParams['messages'],
			ROUTE,
		)

		const assistant = wire.find((m) => m.role === 'assistant') as {
			reasoning_content?: string
		}
		// Concatenated in order, not just the head block.
		expect(assistant.reasoning_content).toBe('first second')
	})

	it('adds no key at all when the turn carried no reasoning', () => {
		// An empty string is not the same as absent: the vendor validates this
		// field's presence in some flows, and sending `reasoning_content: ''`
		// asserts the model thought and produced nothing.
		const wire = toDeepSeekMessages(
			[{ role: 'assistant', content: 'plain' }] as ChatCompletionParams['messages'],
			ROUTE,
		)
		expect('reasoning_content' in (wire[0] as object)).toBe(false)
	})

	it('drops a redacted block rather than replaying its placeholder as thought', () => {
		// `redacted_thinking` carries no readable text — replaying it would put
		// a placeholder into the model's context as if it were reasoning.
		const wire = toDeepSeekMessages(
			[
				{
					role: 'assistant',
					content: 'x',
					reasoning: [{ type: 'redacted_thinking', encrypted: 'opaque' }],
				},
			] as ChatCompletionParams['messages'],
			ROUTE,
		)
		expect('reasoning_content' in (wire[0] as object)).toBe(false)
	})

	it.each([
		['missing replay state', { type: 'model', ...ROUTE }],
		[
			'foreign provider source',
			{
				type: 'model',
				...ROUTE,
				providerId: 'anthropic',
				replayState: replayState('thought'),
			},
		],
		[
			'another chain member',
			{
				type: 'model',
				...ROUTE,
				chainIndex: 1,
				replayState: replayState('thought', { ...ROUTE, chainIndex: 1 }),
			},
		],
		[
			'unknown envelope version',
			{
				type: 'model',
				...ROUTE,
				replayState: { ...replayState('thought'), version: 2 },
			},
		],
		[
			'envelope route disagreement',
			{
				type: 'model',
				...ROUTE,
				replayState: replayState('thought', {
					...ROUTE,
					model: 'deepseek-v4-pro',
				}),
			},
		],
		[
			'durable reasoning disagreement',
			{
				type: 'model',
				...ROUTE,
				replayState: replayState('different thought'),
			},
		],
	] as const)('degrades %s to provider-neutral assistant history', (_name, source) => {
		const wire = toDeepSeekMessages(
			[
				{
					role: 'assistant',
					content: 'answer',
					reasoning: [{ type: 'thinking', text: 'thought' }],
					source,
				},
			] as ChatCompletionParams['messages'],
			ROUTE,
		)

		expect('reasoning_content' in (wire[0] as object)).toBe(false)
		expect(wire[0]).toMatchObject({ role: 'assistant', content: 'answer' })
	})

	it('does not reinterpret a signed block from another adapter as reasoning_content', () => {
		const wire = toDeepSeekMessages(
			[
				{
					role: 'assistant',
					content: 'answer',
					reasoning: [{ type: 'thinking', text: 'thought', signature: 'foreign-sig' }],
					source: {
						type: 'model',
						...ROUTE,
						replayState: replayState('thought'),
					},
				},
			] as ChatCompletionParams['messages'],
			ROUTE,
		)

		expect('reasoning_content' in (wire[0] as object)).toBe(false)
	})

	it('does not replay a valid old-model envelope into a different target model', () => {
		const wire = toDeepSeekMessages(
			[
				{
					role: 'assistant',
					content: 'answer',
					reasoning: [{ type: 'thinking', text: 'thought' }],
					source: {
						type: 'model',
						...ROUTE,
						replayState: replayState('thought'),
					},
				},
			] as ChatCompletionParams['messages'],
			{ ...ROUTE, model: 'deepseek-v4-pro' },
		)

		expect('reasoning_content' in (wire[0] as object)).toBe(false)
	})
})

describe('the stream maps reasoning_content onto reasoning deltas', () => {
	function providerOver(chunks: unknown[]): DeepSeekProvider {
		const provider = new DeepSeekProvider({ apiKey: 'sk-test' })
		;(provider as unknown as { client: unknown }).client = {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							for (const c of chunks) yield c
						},
					}),
				},
			},
		}
		return provider
	}

	async function drain(provider: DeepSeekProvider): Promise<StreamChunk[]> {
		const out: StreamChunk[] = []
		for await (const c of provider.chatStream(params({ thinking: { type: 'enabled' } }))) {
			out.push(c)
		}
		return out
	}

	it('emits reasoning fragments, then closes the block when content starts', () => {
		const chunks = [
			{ id: 'a', choices: [{ delta: { reasoning_content: 'think ' } }] },
			{ id: 'a', choices: [{ delta: { reasoning_content: 'more' } }] },
			{ id: 'a', choices: [{ delta: { content: 'answer' } }] },
			{ id: 'a', choices: [{ delta: {}, finish_reason: 'stop' }] },
		]
		return drain(providerOver(chunks)).then((out) => {
			const reasoning = out.filter((c) => c.delta.reasoning)
			expect(reasoning.map((c) => c.delta.reasoning?.text)).toEqual(['think ', 'more', undefined])
			// The close arrives BEFORE the content chunk, which is the only
			// boundary this wire gives — without it a consumer's reasoning pane
			// never receives `done` and stays open for the life of the run.
			expect(reasoning.at(-1)?.delta.reasoning?.done).toBe(true)
			const closeAt = out.findIndex((c) => c.delta.reasoning?.done)
			const contentAt = out.findIndex((c) => c.delta.content === 'answer')
			expect(closeAt).toBeLessThan(contentAt)
		})
	})

	it('publishes a versioned route-bound envelope only when the response finishes', async () => {
		const out = await drain(
			providerOver([
				{
					id: 'r',
					choices: [{ delta: { reasoning_content: 'exact thought' } }],
				},
				{ id: 'r', choices: [{ delta: { content: 'answer' } }] },
				{ id: 'r', choices: [{ delta: {}, finish_reason: 'stop' }] },
			]),
		)
		const stateChunks = out.filter((chunk) => chunk.replayState !== undefined)

		expect(stateChunks).toHaveLength(1)
		expect(stateChunks[0]?.replayState).toEqual(replayState('exact thought'))
		expect(stateChunks[0]?.finishReason).toBe('stop')
	})

	it('closes a block on a turn that was all reasoning and no content', () => {
		// The model thought and then stopped. Without this the block never
		// closes at all, which is the same stall in a rarer shape.
		const chunks = [
			{ id: 'b', choices: [{ delta: { reasoning_content: 'only thought' } }] },
			{ id: 'b', choices: [{ delta: {}, finish_reason: 'stop' }] },
		]
		return drain(providerOver(chunks)).then((out) => {
			expect(out.some((c) => c.delta.reasoning?.done)).toBe(true)
		})
	})

	it('surfaces reasoning tokens in usage', () => {
		// Billed as output and not separable after the fact, so a thinking run
		// whose reasoning dwarfs its answer reads as an inexplicably expensive
		// short reply if this is dropped.
		const chunks = [
			{
				id: 'c',
				choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 30,
					total_tokens: 40,
					completion_tokens_details: { reasoning_tokens: 25 },
					prompt_cache_hit_tokens: 6,
				},
			},
		]
		return drain(providerOver(chunks)).then((out) => {
			const usage = out.find((c) => c.usage)?.usage as
				| (StreamChunk['usage'] & { reasoningTokens?: number })
				| undefined
			expect(usage?.reasoningTokens).toBe(25)
			// The vendor's flat spelling is read when the details object is
			// absent — a gateway may forward only one of the two.
			expect(usage?.cachedTokens).toBe(6)
		})
	})
})
