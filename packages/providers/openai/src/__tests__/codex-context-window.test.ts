import { describe, expect, it, vi } from 'vitest'

import { CodexProvider } from '../index.js'

let account = 0
function provider() {
	// A fresh account id per case: the listing is kept per account for the life of the process.
	account += 1
	return new CodexProvider({
		accessToken: 'token',
		accountId: `window-account-${account}`,
		model: 'gpt-6.2-sol',
	})
}

function answerWith(p: CodexProvider, get: (...args: unknown[]) => Promise<unknown>) {
	const client = (p as unknown as { client: { get: unknown } }).client
	const fn = vi.fn(get)
	client.get = fn
	return fn
}

describe('the subscription route reads the context window from its model list', () => {
	it('puts a stated window on the listed model at the default 95 percent and resolves it', async () => {
		const p = provider()
		answerWith(p, async () => ({
			models: [
				{ slug: 'gpt-6.2-sol', context_window: 500_000 },
				{ slug: 'other', max_context_window: 272_000 },
				{ slug: 'silent' },
			],
		}))
		const listed = await p.listModels()
		expect(listed.find((m) => m.id === 'gpt-6.2-sol')?.contextWindow).toBe(475_000)
		expect(listed.find((m) => m.id === 'other')?.contextWindow).toBe(258_400)
		expect(listed.find((m) => m.id === 'silent')?.contextWindow).toBeUndefined()
		expect(await p.resolveContextWindow('gpt-6.2-sol')).toBe(475_000)
		expect(await p.resolveContextWindow('GPT-6.2-SOL')).toBe(475_000)
		expect(await p.resolveContextWindow('silent')).toBeUndefined()
	})

	it('prefers context_window over max_context_window and applies the percent the row sends', async () => {
		const p = provider()
		answerWith(p, async () => ({
			models: [
				{ slug: 'both', context_window: 272_000, max_context_window: 1_000_000 },
				{ slug: 'only-max', max_context_window: 1_000_000 },
				{ slug: 'whole', context_window: 272_000, effective_context_window_percent: 100 },
				{ slug: 'half', context_window: 200_000, effective_context_window_percent: 50 },
				{ slug: 'nonsense', context_window: 200_000, effective_context_window_percent: 0 },
			],
		}))
		expect(await p.resolveContextWindow('both')).toBe(258_400)
		expect(await p.resolveContextWindow('only-max')).toBe(950_000)
		expect(await p.resolveContextWindow('whole')).toBe(272_000)
		expect(await p.resolveContextWindow('half')).toBe(100_000)
		expect(await p.resolveContextWindow('nonsense')).toBe(190_000)
	})

	it('reports the compaction limit held to 90% of the window, or 90% when the row sends none', async () => {
		const p = provider()
		answerWith(p, async () => ({
			models: [
				{ slug: 'below', context_window: 272_000, auto_compact_token_limit: 200_000 },
				{ slug: 'above', context_window: 272_000, auto_compact_token_limit: 270_000 },
				{ slug: 'none', context_window: 272_000 },
				{ slug: 'limit-only', auto_compact_token_limit: 150_000 },
				{ slug: 'text', context_window: '272000', auto_compact_token_limit: '100000' },
				{ slug: 'nothing' },
			],
		}))
		const listed = await p.listModels()
		expect(listed.find((m) => m.id === 'below')?.autoCompactTokenLimit).toBe(200_000)
		expect(listed.find((m) => m.id === 'above')?.autoCompactTokenLimit).toBe(244_800)
		expect(listed.find((m) => m.id === 'none')?.autoCompactTokenLimit).toBe(244_800)
		expect(listed.find((m) => m.id === 'limit-only')?.autoCompactTokenLimit).toBe(150_000)
		expect(listed.find((m) => m.id === 'text')?.autoCompactTokenLimit).toBe(100_000)
		expect(listed.find((m) => m.id === 'nothing')?.autoCompactTokenLimit).toBeUndefined()
		expect(await p.resolveAutoCompactLimit('ABOVE')).toBe(244_800)
		expect(await p.resolveAutoCompactLimit('nothing')).toBeUndefined()
		expect(await p.resolveAutoCompactLimit('absent')).toBeUndefined()
	})

	it('asks for the list the way the backend defines it', async () => {
		const p = provider()
		const get = answerWith(p, async () => ({ models: [] }))
		await p.listModels()
		expect(String(get.mock.calls[0]?.[0])).toMatch(/^\/models\?client_version=\d+\.\d+\.\d+$/)
	})

	it('asks the listing once and keeps the answer', async () => {
		const p = provider()
		const get = answerWith(p, async () => ({
			models: [{ slug: 'a', context_window: 300_000 }],
		}))
		await p.resolveContextWindow('a')
		await p.resolveContextWindow('a')
		expect(get).toHaveBeenCalledTimes(1)
	})

	it('answers undefined and does not fail when the listing fails, and does not ask again at once', async () => {
		const p = provider()
		const get = answerWith(p, async () => {
			throw new Error('catalogue unavailable')
		})
		expect(await p.resolveContextWindow('a')).toBeUndefined()
		expect(await p.resolveContextWindow('a')).toBeUndefined()
		expect(get).toHaveBeenCalledTimes(1)
	})

	it('cuts a listing that hangs short instead of holding the turn', async () => {
		vi.useFakeTimers()
		try {
			const p = provider()
			answerWith(
				p,
				(_path, options) =>
					new Promise((_resolve, reject) => {
						;(options as { signal: AbortSignal }).signal.addEventListener('abort', () =>
							reject(new Error('aborted')),
						)
					}),
			)
			const pending = p.resolveContextWindow('a')
			await vi.advanceTimersByTimeAsync(3_000)
			expect(await pending).toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it('reads a window and a percentage sent as strings', async () => {
		const p = provider()
		answerWith(p, async () => ({
			models: [
				{ slug: 'texty', context_window: '272000', effective_context_window_percent: '95' },
				{ slug: 'junk', context_window: 'lots' },
			],
		}))
		expect(await p.resolveContextWindow('texty')).toBe(258_400)
		expect(await p.resolveContextWindow('junk')).toBeUndefined()
	})

	it('shares one listing between callers that arrive together', async () => {
		const p = provider()
		const get = answerWith(p, async () => ({ models: [{ slug: 'a', context_window: 300_000 }] }))
		const both = await Promise.all([p.resolveContextWindow('a'), p.resolveContextWindow('a')])
		expect(both).toEqual([285_000, 285_000])
		expect(get).toHaveBeenCalledTimes(1)
	})

	it('lets the caller abort', async () => {
		const p = provider()
		answerWith(p, async () => ({ models: [] }))
		const controller = new AbortController()
		controller.abort(new Error('stop'))
		await expect(p.resolveContextWindow('a', controller.signal)).rejects.toThrow('stop')
	})
})
