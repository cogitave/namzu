import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	LIMITS_MIN_REFRESH_MS,
	LIMITS_NOTIFICATION,
	type LimitsFeedSource,
	createLimitsFeed,
	noticeFromLimits,
} from '../desktop-limits-feed.js'

const SECRET_PLAN = 'Team-Plan-Value-123'

const PASSIVE = new Set(['windowed'])

function clock(start = 1_000_000) {
	let now = start
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms
		},
	}
}

function source(
	id: string,
	kind: LimitsFeedSource['kind'],
	read: () => Promise<unknown>,
): LimitsFeedSource & { reads: number } {
	const entry = {
		id,
		label: id.toUpperCase(),
		kind,
		reads: 0,
		providers: [
			{
				readLimits: async () => {
					entry.reads += 1
					return (await read()) as never
				},
			},
		],
	}
	return entry as LimitsFeedSource & { reads: number }
}

afterEach(() => vi.restoreAllMocks())

describe('noticeFromLimits', () => {
	it('clamps fractions, drops what is not a number and keeps only the known fields', () => {
		const out = noticeFromLimits({
			windows: [
				{ label: '5-hour limit', usedFraction: 1.7, resetsAt: 5 },
				{ label: 'bad', usedFraction: Number.NaN },
			],
			credit: { currency: 'USD', used: 1, limit: Number.POSITIVE_INFINITY },
			asOf: 9,
			extra: 'x',
		} as never)
		expect(out.windows).toEqual([{ label: '5-hour limit', usedFraction: 1, resetsAt: 5 }])
		expect(out.credit).toEqual({ currency: 'USD', used: 1 })
		expect(out).not.toHaveProperty('extra')
		expect(out).not.toHaveProperty('plan')
	})
})

describe('the limits feed', () => {
	it('reads a window from a provider that needs no request, as often as asked', async () => {
		const time = clock()
		const windowed = source('windowed', 'sign-in', async () => ({
			windows: [{ label: '5-hour limit', usedFraction: 0.27 }],
			asOf: time.now(),
		}))
		const feed = createLimitsFeed({
			passive: PASSIVE,
			sources: () => [windowed],
			notify: vi.fn(),
			now: time.now,
		})
		await feed.refresh()
		time.advance(1000)
		const view = await feed.refresh()
		expect(windowed.reads).toBe(2)
		expect(view.providers[0]).toMatchObject({
			provider: 'windowed',
			kind: 'sign-in',
			windows: [{ label: '5-hour limit', usedFraction: 0.27 }],
		})
		expect(view.providers[0]).not.toHaveProperty('spend')
	})

	it('asks a provider that must be asked at most once a minute', async () => {
		const time = clock()
		const router = source('openrouter', 'key', async () => ({
			credit: { currency: 'credits', used: 3, limit: 10 },
			asOf: time.now(),
		}))
		const feed = createLimitsFeed({ sources: () => [router], notify: vi.fn(), now: time.now })
		await feed.refresh()
		time.advance(LIMITS_MIN_REFRESH_MS - 1)
		await feed.refresh()
		await feed.refresh()
		expect(router.reads).toBe(1)
		time.advance(1)
		const view = await feed.refresh()
		expect(router.reads).toBe(2)
		expect(view.providers[0]?.credit).toEqual({ currency: 'credits', used: 3, limit: 10 })
	})

	it('counts a request that learned nothing, keeps the last reading, and says nothing it does not know', async () => {
		const time = clock()
		let answer: unknown = { credit: { currency: 'CNY', remaining: 5 }, asOf: 1 }
		const deep = source('deepseek', 'key', async () => answer)
		const feed = createLimitsFeed({ sources: () => [deep], notify: vi.fn(), now: time.now })
		await feed.refresh()
		answer = undefined
		time.advance(LIMITS_MIN_REFRESH_MS)
		const view = await feed.refresh()
		expect(deep.reads).toBe(2)
		expect(view.providers[0]?.credit).toEqual({ currency: 'CNY', remaining: 5 })
		time.advance(10)
		await feed.refresh()
		expect(deep.reads).toBe(2)
	})

	it('survives a provider that throws', async () => {
		const bad = source('openrouter', 'key', async () => {
			throw new Error('offline')
		})
		const feed = createLimitsFeed({ sources: () => [bad], notify: vi.fn(), now: clock().now })
		const view = await feed.refresh()
		expect(view.providers).toEqual([{ provider: 'openrouter', label: 'OPENROUTER', kind: 'key' }])
	})

	it('estimates spend for a key the vendor reports nothing about, and only then', async () => {
		const spend = vi.fn(async (provider: string) => ({
			usd: provider === 'keyed' ? 3.1 : 9,
			days: 30,
			partial: false,
		}))
		const sources = [
			source('keyed', 'key', async () => undefined),
			source('openrouter', 'key', async () => ({ credit: { currency: 'USD', used: 1 }, asOf: 1 })),
			source('codex', 'sign-in', async () => undefined),
			source('ollama', 'local', async () => undefined),
		]
		const feed = createLimitsFeed({
			sources: () => sources,
			spend,
			notify: vi.fn(),
			now: clock().now,
		})
		const view = await feed.refresh()
		const by = Object.fromEntries(view.providers.map((row) => [row.provider, row]))
		expect(by.keyed?.spend).toEqual({ usd: 3.1, days: 30, partial: false })
		expect(by.openrouter).not.toHaveProperty('spend')
		expect(by.codex).not.toHaveProperty('spend')
		expect(by.ollama).not.toHaveProperty('spend')
		expect(spend).toHaveBeenCalledTimes(1)
	})

	it('leaves a zero spend out instead of drawing it', async () => {
		const feed = createLimitsFeed({
			sources: () => [source('keyed', 'key', async () => undefined)],
			spend: async () => ({ usd: 0, days: 30, partial: false }),
			notify: vi.fn(),
			now: clock().now,
		})
		expect((await feed.refresh()).providers[0]).not.toHaveProperty('spend')
	})

	it('says a changed reading after a turn, once, and nothing when it did not change', async () => {
		const time = clock()
		let used = 0.1
		const notify = vi.fn()
		const windowed = source('windowed', 'sign-in', async () => ({
			windows: [{ label: '5-hour limit', usedFraction: used }],
			asOf: 1,
		}))
		const router = source('openrouter', 'key', async () => ({
			credit: { currency: 'USD', used: 1 },
			asOf: 1,
		}))
		const feed = createLimitsFeed({
			passive: PASSIVE,
			sources: () => [windowed, router],
			notify,
			now: time.now,
		})
		await feed.noteTurnEnd()
		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify.mock.calls[0]?.[0]).toBe(LIMITS_NOTIFICATION)
		await feed.noteTurnEnd()
		expect(notify).toHaveBeenCalledTimes(1)
		used = 0.5
		await feed.noteTurnEnd()
		expect(notify).toHaveBeenCalledTimes(2)
		// A turn end never makes a request of its own for a provider that has to be asked.
		expect(router.reads).toBe(0)
	})

	it('does not stop a turn when the stream is closed', async () => {
		const windowed = source('windowed', 'sign-in', async () => ({
			windows: [{ label: 'w', usedFraction: 0.2 }],
			asOf: 1,
		}))
		const feed = createLimitsFeed({
			passive: PASSIVE,
			sources: () => [windowed],
			notify: () => {
				throw new Error('closed')
			},
			now: clock().now,
		})
		await expect(feed.noteTurnEnd()).resolves.toBeUndefined()
	})

	it('logs no value: nothing is written to the console while it runs, and the source has no logger', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
			vi.spyOn(console, name).mockImplementation(() => {}),
		)
		const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		const windowed = source('windowed', 'sign-in', async () => ({
			windows: [{ label: '5-hour limit', usedFraction: 0.42 }],
			plan: SECRET_PLAN,
			asOf: 1,
		}))
		const bad = source('openrouter', 'key', async () => {
			throw new Error(`failed with ${SECRET_PLAN}`)
		})
		const feed = createLimitsFeed({
			passive: PASSIVE,
			sources: () => [windowed, bad],
			notify: vi.fn(),
			now: clock().now,
		})
		await feed.refresh()
		await feed.noteTurnEnd()
		for (const spy of spies) expect(spy).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
		for (const file of [
			'../desktop-limits-feed.ts',
			'../desktop-limits-spend.ts',
			'../../integrations/limits/sources.ts',
		]) {
			const text = readFileSync(new URL(file, import.meta.url), 'utf8')
			expect(text).not.toMatch(/console\./)
			expect(text).not.toMatch(/\blog(ger)?\b\s*[.(]/i)
			expect(text).not.toMatch(/writeFile|appendFile|localStorage/)
		}
	})
})
