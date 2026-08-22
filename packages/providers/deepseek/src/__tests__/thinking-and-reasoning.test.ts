import type { ChatCompletionParams, ProviderRoute, StreamChunk } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	DeepSeekProvider,
	assertEffortUnsupported,
	assertSamplingUsable,
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
	it('publishes an exact empty menu for this wire', () => {
		const provider = new DeepSeekProvider({ apiKey: 'test-key' })

		expect(provider.reasoningEffortLevelsFor('deepseek-v4-flash')).toEqual([])
	})

	it('is refused, because this wire accepts it and validates nothing', () => {
		// Measured: `thinking.effort: 'bogus'` returns 200, and
		// `effort: 'none'` still produces reasoning tokens. Only
		// `thinking.type` is validated. Passing an effort through would change
		// nothing and report success.
		expect(() => assertEffortUnsupported(params({ effort: 'high' }))).toThrow(/not carried/)
	})

	it('is silent when the caller asked for none', () => {
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
