import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'
import { refusalFallbackFromList } from '../refusal-fallback.js'

/**
 * An assistant entry with no text, no reasoning and no call (a refused or
 * interrupted reply) was serialised with `JSON.stringify(null)` and sent as
 * the literal text "null". It has no wire form and is left out.
 */

async function wireMessages(messages: ChatCompletionParams['messages']): Promise<unknown[]> {
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	const create = vi.fn(async () =>
		(async function* () {
			yield { type: 'message_start', message: { id: 'm' } }
			yield {
				type: 'message_delta',
				delta: { stop_reason: 'end_turn' },
				usage: { output_tokens: 1 },
			}
			yield { type: 'message_stop' }
		})(),
	)
	;(provider as unknown as { client: unknown }).client = {
		messages: { create },
	}
	for await (const _ of provider.chatStream({
		model: 'claude-sonnet-5-5',
		messages,
	})) {
		// drain
	}
	const body = create.mock.calls[0] as unknown as [{ messages: unknown[] }]
	return body[0].messages
}

describe('empty assistant history on the Anthropic wire', () => {
	it.each([null, ''])('never sends an assistant with content %j as text', async (content) => {
		const sent = await wireMessages([
			{ role: 'user', content: 'before' },
			{ role: 'assistant', content },
			{ role: 'assistant', content, toolCalls: [] },
			{ role: 'user', content: 'continue' },
		])
		expect(JSON.stringify(sent)).not.toContain('"null"')
		expect(sent.some((entry) => (entry as { role: string }).role === 'assistant')).toBe(false)
	})

	it('keeps an assistant that has text', async () => {
		const sent = await wireMessages([
			{ role: 'user', content: 'before' },
			{ role: 'assistant', content: 'an answer' },
			{ role: 'user', content: 'continue' },
		])
		expect(sent).toContainEqual({ role: 'assistant', content: 'an answer' })
	})
})

describe('where a refused Anthropic request is re-run', () => {
	const listed = [
		'claude-haiku-5-5',
		'claude-sonnet-5-5',
		'claude-opus-5-5',
		'claude-opus-5',
		'claude-sonnet-4-5-20250929',
	]

	it('sends a Sonnet refusal to Opus of the same generation, Opus to Sonnet, Haiku to Sonnet', () => {
		expect(refusalFallbackFromList('claude-sonnet-5-5', listed)).toBe('claude-opus-5-5')
		expect(refusalFallbackFromList('claude-opus-5-5', listed)).toBe('claude-sonnet-5-5')
		expect(refusalFallbackFromList('claude-haiku-5-5', listed)).toBe('claude-sonnet-5-5')
		expect(refusalFallbackFromList('claude-opus-5', listed)).toBeUndefined()
	})

	it('names nothing this credential cannot serve, nor a different generation', () => {
		expect(refusalFallbackFromList('claude-sonnet-5-5', ['claude-sonnet-5-5'])).toBeUndefined()
		expect(refusalFallbackFromList('claude-sonnet-4-5-20250929', listed)).toBeUndefined()
		expect(refusalFallbackFromList('not-a-model', listed)).toBeUndefined()
	})

	function providerListing(ids: string[] | Error) {
		const provider = new AnthropicProvider({ apiKey: 'test-key' })
		;(provider as unknown as { client: unknown }).client = {
			models: {
				list: async () => {
					if (ids instanceof Error) throw ids
					return { data: ids.map((id) => ({ id })), hasNextPage: () => false }
				},
			},
		}
		return provider
	}

	it("prefers the service's recommended model when the account's list has it", async () => {
		const provider = providerListing(listed)
		expect(
			await provider.refusalFallbackFor('claude-sonnet-5-5', {
				recommendedModel: 'claude-opus-5',
			}),
		).toBe('claude-opus-5')
	})

	it('ignores a recommendation the account cannot use and falls back to the declared order', async () => {
		const provider = providerListing(listed)
		expect(
			await provider.refusalFallbackFor('claude-sonnet-5-5', {
				recommendedModel: 'claude-unlisted',
			}),
		).toBe('claude-opus-5-5')
	})

	it('names nothing when the model list cannot be read', async () => {
		const provider = providerListing(new Error('offline'))
		expect(await provider.refusalFallbackFor('claude-sonnet-5-5', {})).toBeUndefined()
	})
})
