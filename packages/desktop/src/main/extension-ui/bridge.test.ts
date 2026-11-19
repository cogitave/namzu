import { describe, expect, it, vi } from 'vitest'
import {
	type BridgeBackend,
	ERROR_SENTENCE,
	HOST_REPLY_MAX_BYTES,
	MAX_IN_FLIGHT,
	MAX_MESSAGE_BYTES,
	MAX_STRIKES,
	PageBridge,
	RATE_BURST,
	RATE_PER_SECOND,
	isPlainJson,
} from './bridge.js'

const make = (over: Partial<ConstructorParameters<typeof PageBridge>[0]> = {}) => {
	let t = 1_000
	const calls: unknown[][] = []
	const opened: string[] = []
	let closed = 0
	const backend: BridgeBackend = {
		extension: async (m, p, a) => {
			calls.push([m, p, a])
			return { kind: 'x', rows: [] }
		},
		theme: () => ({ dark: false, tokens: { '--ns-bg': '#fff' } }),
		locale: () => ({ locale: 'en' }),
		state: () => ({ state: 'running' }),
		openNamzu: (w) => void opened.push(w),
	}
	const b = new PageBridge({
		allow: ['query:counts', 'action:pick-day'],
		host: ['theme', 'locale', 'state', 'openNamzu'],
		maxBytes: { 'query:counts': 200, 'action:pick-day': 200 },
		backend,
		now: () => t,
		onClose: () => closed++,
		...over,
	})
	return {
		b,
		calls,
		opened,
		closed: () => closed,
		tick: (ms: number) => {
			t += ms
		},
		send: (m: string, p?: unknown, id = 1, a = false) => b.handle({ v: 1, id, m, p, a }, a),
	}
}

describe('a page can call only what its manifest declares', () => {
	it('a declared query reaches the extension, and the activation stamp comes from Namzu, not the message', async () => {
		const x = make()
		const r = await x.send('query:counts', { day: 'today' }, 7, false)
		expect(r).toEqual({ v: 1, id: 7, ok: true, r: { kind: 'x', rows: [] } })
		expect(x.calls).toEqual([['query:counts', { day: 'today' }, false]])
		// A page that claims `a: true` in its own envelope gets nothing: the argument is what counts.
		await x.b.handle({ v: 1, id: 8, m: 'action:pick-day', p: {}, a: true }, false)
		expect(x.calls.at(-1)?.[2]).toBe(false)
		await x.b.handle({ v: 1, id: 9, m: 'action:pick-day', p: {} }, true)
		expect(x.calls.at(-1)?.[2]).toBe(true)
	})
	it("an undeclared method never reaches anything: another extension, Namzu's own RPC, the engine, a shell, a window", async () => {
		const x = make()
		for (const m of [
			'query:other',
			'action:format-disk',
			'namzu/extensions/list',
			'namzu/config/set',
			'com.other.ext:query:counts',
			'host:openExternal',
			'host:clipboard',
			'host:',
			'shell:exec',
			'query:counts/../../x',
			'QUERY:counts',
			'',
		]) {
			const r = await x.send(m, {}, 3)
			expect(r, m).toMatchObject({
				ok: false,
				e: { code: 'not-declared', message: ERROR_SENTENCE['not-declared'] },
			})
		}
		expect(x.calls).toHaveLength(0)
		expect(x.opened).toHaveLength(0)
	})
	it('a host helper the manifest did not list is not declared either', async () => {
		const x = make({ host: ['theme'] })
		expect(await x.send('host:theme')).toMatchObject({ ok: true })
		expect(await x.send('host:locale')).toMatchObject({ ok: false, e: { code: 'not-declared' } })
		expect(await x.send('host:openNamzu', { where: 'notice' })).toMatchObject({
			ok: false,
			e: { code: 'not-declared' },
		})
	})
	it("host:openNamzu opens only Namzu's own screens and tells the page nothing of them", async () => {
		const x = make()
		expect(await x.send('host:openNamzu', { where: 'what-is-collected' })).toMatchObject({
			ok: true,
			r: { opened: true },
		})
		expect(x.opened).toEqual(['what-is-collected'])
		for (const where of ['install', 'https://example.com', undefined, 7, '../x'])
			expect(await x.send('host:openNamzu', { where })).toMatchObject({
				ok: false,
				e: { code: 'bad-params' },
			})
		expect(x.opened).toEqual(['what-is-collected'])
	})
	it("host answers are small and are the page's own view of things: theme, locale, state", async () => {
		const x = make()
		expect(await x.send('host:theme')).toMatchObject({ ok: true, r: { dark: false } })
		expect(await x.send('host:locale')).toMatchObject({ ok: true, r: { locale: 'en' } })
		expect(await x.send('host:state')).toMatchObject({ ok: true, r: { state: 'running' } })
		const big = make({
			backend: {
				extension: async () => 1,
				theme: () => 'x'.repeat(HOST_REPLY_MAX_BYTES + 1),
				locale: () => 1,
				state: () => 1,
				openNamzu: () => {},
			},
		})
		expect(await big.send('host:theme')).toMatchObject({ ok: false, e: { code: 'too-large' } })
	})
})

describe("errors are Namzu's sentences, never text from the extension", () => {
	it('maps what the engine says to a fixed code and sentence', async () => {
		const cases: [string, string][] = [
			['bad-params', 'bad-params'],
			['gesture-required', 'gesture-required'],
			['not-running', 'unavailable'],
			['R1', 'not-declared'],
			['R2', 'answer-dropped'],
			['R3', 'answer-dropped'],
			['mystery', 'unavailable'],
		]
		for (const [engine, code] of cases) {
			const x = make({
				backend: {
					extension: async () => {
						throw Object.assign(new Error('Hacked: click here to sign in'), { code: engine })
					},
					theme: () => 1,
					locale: () => 1,
					state: () => 1,
					openNamzu: () => {},
				},
			})
			const r = await x.send('query:counts')
			expect(r).toMatchObject({
				ok: false,
				e: { code, message: ERROR_SENTENCE[code as keyof typeof ERROR_SENTENCE] },
			})
			expect(JSON.stringify(r)).not.toContain('Hacked')
		}
	})
	it('an answer larger than the method allows is refused', async () => {
		const x = make({
			backend: {
				extension: async () => ({ pad: 'x'.repeat(500) }),
				theme: () => 1,
				locale: () => 1,
				state: () => 1,
				openNamzu: () => {},
			},
		})
		expect(await x.send('query:counts')).toMatchObject({ ok: false, e: { code: 'too-large' } })
	})
})

describe('limits', () => {
	it('a message over 64 KiB, an unknown shape, a bad version and a non-integer id are strikes; three close the page', async () => {
		const x = make()
		expect(
			await x.b.handle(
				{ v: 1, id: 1, m: 'query:counts', p: { pad: 'x'.repeat(MAX_MESSAGE_BYTES) } },
				false,
			),
		).toMatchObject({ ok: false, e: { code: 'too-large' } })
		expect(x.closed()).toBe(0)
		await x.b.handle({ v: 2, id: 2, m: 'query:counts' }, false)
		expect(x.closed()).toBe(0)
		await x.b.handle({ v: 1, id: 1.5, m: 'query:counts' }, false)
		expect(x.b.isClosed).toBe(true)
		expect(x.closed()).toBe(1)
		expect(MAX_STRIKES).toBe(3)
		// A closed page is not answered at all, and closing happens once.
		expect(await x.send('query:counts')).toBeUndefined()
		await x.b.handle('garbage', false)
		expect(x.closed()).toBe(1)
	})
	it('functions, ArrayBuffers, Blobs and other non-JSON values are refused', () => {
		expect(isPlainJson({ a: [1, 'x', null, true, { b: 2 }] })).toBe(true)
		for (const v of [
			() => 1,
			new ArrayBuffer(2),
			new Map(),
			new Date(),
			Symbol('x'),
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			new Uint8Array(2),
			{ f() {} },
			Object.create({ inherited: 1 }),
		])
			expect(isPlainJson(v), String(v)).toBe(false)
		let deep: unknown = 1
		for (let i = 0; i < 20; i++) deep = { x: deep }
		expect(isPlainJson(deep)).toBe(false)
	})
	it('at most 4 calls are in flight at once', async () => {
		const gate: (() => void)[] = []
		const x = make({
			backend: {
				extension: () => new Promise((r) => gate.push(() => r({ ok: 1 }))),
				theme: () => 1,
				locale: () => 1,
				state: () => 1,
				openNamzu: () => {},
			},
		})
		const first = Array.from({ length: MAX_IN_FLIGHT }, (_, i) => x.send('query:counts', {}, i + 1))
		await Promise.resolve()
		expect(await x.send('query:counts', {}, 99)).toMatchObject({
			ok: false,
			e: { code: 'rate-limited' },
		})
		for (const g of gate) g()
		for (const r of await Promise.all(first)) expect(r).toMatchObject({ ok: true })
		// A slot is free again once a call finishes.
		const again = x.send('query:counts', {}, 100)
		gate.at(-1)?.()
		expect(await again).toMatchObject({ ok: true })
	})
	it('a token bucket of 20 a second with a burst of 40, on an injected clock', async () => {
		const x = make({ maxBytes: { 'query:counts': 4096 } })
		for (let i = 1; i <= RATE_BURST; i++)
			expect(await x.send('host:theme', undefined, i)).toMatchObject({ ok: true })
		expect(await x.send('host:theme', undefined, 1000)).toMatchObject({
			ok: false,
			e: { code: 'rate-limited' },
		})
		x.tick(1000 / RATE_PER_SECOND)
		expect(await x.send('host:theme', undefined, 1001)).toMatchObject({ ok: true })
		expect(await x.send('host:theme', undefined, 1002)).toMatchObject({
			ok: false,
			e: { code: 'rate-limited' },
		})
		x.tick(5000)
		for (let i = 0; i < RATE_BURST; i++)
			expect(await x.send('host:theme', undefined, 2000 + i)).toMatchObject({ ok: true })
		expect(await x.send('host:theme', undefined, 3000)).toMatchObject({
			ok: false,
			e: { code: 'rate-limited' },
		})
	})
	it('a rate-limited call is not a strike', async () => {
		const x = make()
		for (let i = 1; i <= RATE_BURST + 10; i++) await x.send('host:theme', undefined, i)
		expect(x.b.isClosed).toBe(false)
		vi.useRealTimers()
	})
})
