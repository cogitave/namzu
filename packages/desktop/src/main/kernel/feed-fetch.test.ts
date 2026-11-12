import { describe, expect, it } from 'vitest'
import { type FetchLike, createFeedFetch } from './feed-fetch.js'

function timers() {
	const pending = new Map<number, () => void>()
	let next = 0
	return {
		after: (_ms: number, run: () => void) => {
			const id = next++
			pending.set(id, run)
			return () => pending.delete(id)
		},
		fire: () => {
			for (const run of [...pending.values()]) run()
		},
		count: () => pending.size,
	}
}

async function* body(...parts: string[]): AsyncGenerator<Uint8Array> {
	for (const part of parts) yield new TextEncoder().encode(part)
}

async function read(stream: AsyncIterable<Uint8Array> | null): Promise<string> {
	let out = ''
	for await (const chunk of stream ?? []) out += new TextDecoder().decode(chunk)
	return out
}

describe('the feed fetch', () => {
	it('sends exactly the headers it is given, no cookies, and reports the final address', async () => {
		const calls: Parameters<FetchLike>[] = []
		const t = timers()
		const fetch: FetchLike = async (...args) => {
			calls.push(args)
			return { status: 200, url: 'https://feed.test/final', body: body('abc') }
		}
		const feed = createFeedFetch({ fetch, after: t.after })
		const response = await feed('https://feed.test/a', {
			headers: { 'User-Agent': 'namzu-desktop' },
		})
		expect(calls[0]?.[0]).toBe('https://feed.test/a')
		expect(calls[0]?.[1].headers).toEqual({ 'User-Agent': 'namzu-desktop' })
		expect(calls[0]?.[1].redirect).toBe('manual')
		expect(calls[0]?.[1].credentials).toBe('omit')
		expect(response).toMatchObject({ status: 200, url: 'https://feed.test/a' })
		expect(await read(response.body)).toBe('abc')
		// Nothing is left armed once the body has been read.
		expect(t.count()).toBe(0)
	})

	it('follows a redirect one hop at a time and reports where it ended', async () => {
		const asked: string[] = []
		const fetch: FetchLike = async (url) => {
			asked.push(url)
			return url.endsWith('/a')
				? { status: 302, location: '/b', body: null }
				: { status: 200, body: body('done') }
		}
		const feed = createFeedFetch({ fetch, after: timers().after })
		const response = await feed('https://feed.test/a', { headers: {} })
		expect(asked).toEqual(['https://feed.test/a', 'https://feed.test/b'])
		expect(response.url).toBe('https://feed.test/b')
		expect(await read(response.body)).toBe('done')
	})

	it('never sends a request to a redirect target that is not allowed', async () => {
		for (const location of [
			'http://evil.example/x',
			'file:///etc/passwd',
			'https://user:secret@feed.test/x',
		]) {
			const asked: string[] = []
			const fetch: FetchLike = async (url) => {
				asked.push(url)
				return { status: 301, location, body: null }
			}
			const feed = createFeedFetch({ fetch, after: timers().after })
			await expect(feed('https://feed.test/a', { headers: {} })).rejects.toThrow(/not allowed/u)
			expect(asked).toEqual(['https://feed.test/a'])
		}
	})

	it('stops after too many redirects and refuses one that names no address', async () => {
		const loop: FetchLike = async () => ({ status: 302, location: '/again', body: null })
		await expect(
			createFeedFetch({ fetch: loop, after: timers().after })('https://feed.test/a', {
				headers: {},
			}),
		).rejects.toThrow(/Too many redirects/u)
		const bare: FetchLike = async () => ({ status: 302, body: null })
		await expect(
			createFeedFetch({ fetch: bare, after: timers().after })('https://feed.test/a', {
				headers: {},
			}),
		).rejects.toThrow(/named no address/u)
	})

	it('cuts off a transfer that goes quiet', async () => {
		const t = timers()
		let signal: AbortSignal | undefined
		const fetch: FetchLike = async (_url, init) => {
			signal = init.signal
			return { status: 200, body: body('abc') }
		}
		const feed = createFeedFetch({ fetch, after: t.after, stallMs: 30_000 })
		const response = await feed('https://feed.test/a', { headers: {} })
		expect(signal?.aborted).toBe(false)
		t.fire()
		expect(signal?.aborted).toBe(true)
		await read(response.body)
	})

	it('does not cut off a transfer that keeps making progress', async () => {
		const t = timers()
		let signal: AbortSignal | undefined
		const fetch: FetchLike = async (_url, init) => {
			signal = init.signal
			return { status: 200, body: body('a', 'b') }
		}
		const response = await createFeedFetch({ fetch, after: t.after })('https://feed.test/a', {
			headers: {},
		})
		const iterator = (response.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
		await iterator.next()
		// Each chunk re-arms the timer, so only the newest one counts.
		expect(t.count()).toBe(1)
		await iterator.next()
		expect(signal?.aborted).toBe(false)
	})

	it('passes the caller’s own cancellation on', async () => {
		const t = timers()
		const outer = new AbortController()
		let signal: AbortSignal | undefined
		const fetch: FetchLike = async (_url, init) => {
			signal = init.signal
			return { status: 200, body: null }
		}
		const feed = createFeedFetch({ fetch, after: t.after })
		await feed('https://feed.test/a', { headers: {}, signal: outer.signal })
		outer.abort()
		// Settled already (no body): the listener is gone and nothing is armed.
		expect(t.count()).toBe(0)
		expect(signal?.aborted).toBe(false)
		const pending = createFeedFetch({
			fetch: async (_url, init) => {
				signal = init.signal
				return { status: 200, body: body('x') }
			},
			after: t.after,
		})
		const again = new AbortController()
		await pending('https://feed.test/a', { headers: {}, signal: again.signal })
		again.abort()
		expect(signal?.aborted).toBe(true)
	})

	it('gives the failure back and leaves no timer when the request fails', async () => {
		const t = timers()
		const feed = createFeedFetch({
			fetch: async () => {
				throw new Error('connection refused')
			},
			after: t.after,
		})
		await expect(feed('https://feed.test/a', { headers: {} })).rejects.toThrow('connection refused')
		expect(t.count()).toBe(0)
	})
})
