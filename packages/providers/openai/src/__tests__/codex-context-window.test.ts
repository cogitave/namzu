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
	it('puts a stated window on the listed model and resolves it for that model', async () => {
		const p = provider()
		answerWith(p, async () => ({
			models: [
				{ slug: 'gpt-6.2-sol', context_window: 500_000 },
				{ slug: 'other', max_context_window: 272_000 },
				{ slug: 'silent' },
			],
		}))
		const listed = await p.listModels()
		expect(listed.find((m) => m.id === 'gpt-6.2-sol')?.contextWindow).toBe(500_000)
		expect(listed.find((m) => m.id === 'other')?.contextWindow).toBe(272_000)
		expect(listed.find((m) => m.id === 'silent')?.contextWindow).toBeUndefined()
		expect(await p.resolveContextWindow('gpt-6.2-sol')).toBe(500_000)
		expect(await p.resolveContextWindow('GPT-6.2-SOL')).toBe(500_000)
		expect(await p.resolveContextWindow('silent')).toBeUndefined()
	})

	it('applies an effective percentage the backend sends, and none when it sends none', async () => {
		const p = provider()
		answerWith(p, async () => ({
			models: [
				{
					slug: 'trimmed',
					context_window: 272_000,
					effective_context_window_percent: 95,
				},
				{ slug: 'plain', context_window: 272_000 },
				{
					slug: 'nonsense',
					context_window: 272_000,
					effective_context_window_percent: 0,
				},
			],
		}))
		expect(await p.resolveContextWindow('trimmed')).toBe(258_400)
		expect(await p.resolveContextWindow('plain')).toBe(272_000)
		expect(await p.resolveContextWindow('nonsense')).toBe(272_000)
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

	it('lets the caller abort', async () => {
		const p = provider()
		answerWith(p, async () => ({ models: [] }))
		const controller = new AbortController()
		controller.abort(new Error('stop'))
		await expect(p.resolveContextWindow('a', controller.signal)).rejects.toThrow('stop')
	})
})
