import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/**
 * This driver already knew the answer and threw it away.
 *
 * `listModels` has parsed the vendor's `context_length` since it was
 * written, mapped it into `contextWindow`, and nothing downstream ever
 * asked — because `LLMProvider` had no member to return it through. The
 * kernel meanwhile fell back to a hand-maintained prefix table whose own
 * header records the cost: every Claude entry carried 200k including the
 * 1M-window models, so those runs compacted at roughly 14% full.
 *
 * OpenRouter fronts hundreds of models from a dozen vendors, which makes it
 * the driver where a static table drifts fastest and the one where asking
 * is worth the most.
 */

function provider(): OpenRouterProvider {
	return new OpenRouterProvider({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' })
}

function listing(models: { id: string; context_length: number }[]) {
	return vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({
			data: models.map((m) => ({
				id: m.id,
				name: m.id,
				context_length: m.context_length,
				top_provider: { max_completion_tokens: 8_192 },
				pricing: { prompt: '0', completion: '0' },
			})),
		}),
	})
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('the vendor knows its own context window', () => {
	it('reports the length the listing gave for that model', async () => {
		vi.stubGlobal(
			'fetch',
			listing([
				{ id: 'anthropic/claude-sonnet-4-6', context_length: 1_000_000 },
				{ id: 'openai/gpt-5-mini', context_length: 400_000 },
			]),
		)

		const p = provider()

		expect(await p.resolveContextWindow('anthropic/claude-sonnet-4-6')).toBe(1_000_000)
		expect(await p.resolveContextWindow('openai/gpt-5-mini')).toBe(400_000)
	})

	it('answers undefined for a model the listing does not contain', async () => {
		// Not a substituted table value. "I asked and it is not there" leaves
		// the kernel's table exactly as authoritative as it was, while a
		// substitution would present a guess as a vendor answer — which is
		// the failure mode the table itself already produced once.
		vi.stubGlobal(
			'fetch',
			listing([{ id: 'anthropic/claude-sonnet-4-6', context_length: 200_000 }]),
		)

		expect(await provider().resolveContextWindow('some/model-not-listed')).toBeUndefined()
	})

	it('asks the vendor once per process, not once per call', async () => {
		// The listing is several hundred models, and a model's window does not
		// move under a running run.
		const fetchMock = listing([{ id: 'a/b', context_length: 128_000 }])
		vi.stubGlobal('fetch', fetchMock)
		const p = provider()

		await p.resolveContextWindow('a/b')
		await p.resolveContextWindow('a/b')
		await p.resolveContextWindow('a/b')

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('does not cache a failure', async () => {
		// A listing endpoint that was down for a minute must not leave every
		// later call in the process answering from that minute. The failure
		// propagates — the runtime swallows it and falls back to the table —
		// but the next ask is a real one.
		const failing = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
		vi.stubGlobal('fetch', failing)
		const p = provider()

		await expect(p.resolveContextWindow('a/b')).rejects.toThrow()

		vi.stubGlobal('fetch', listing([{ id: 'a/b', context_length: 128_000 }]))
		expect(await p.resolveContextWindow('a/b')).toBe(128_000)
	})
})
