import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChild } from './__fixtures__/fake-child.js'
import { sampleManifest } from './__fixtures__/package-builder.js'
import { parseManifest } from './manifest.js'
import { type Snapshot, Supervisor } from './supervisor.js'
import type { Manifest } from './types.js'

function manifest(over: (m: any) => void = () => {}): Manifest {
	const r = parseManifest(JSON.stringify(sampleManifest(over as never)))
	if (!r.ok) throw new Error(JSON.stringify(r.issues[0]))
	return r.manifest
}

function rig(
	m: Manifest,
	opts: {
		granted?: string[]
		obeysShutdown?: boolean
		endpointReady?: (signal: AbortSignal) => Promise<boolean>
	} = {},
) {
	const children: FakeChild[] = []
	const audits: string[] = []
	const snaps: Snapshot[] = []
	const sup = new Supervisor({
		manifest: m,
		granted: () => opts.granted ?? [],
		audit: (e, d) => audits.push(`${e}${d ? `:${d}` : ''}`),
		onChange: (s) => snaps.push(s),
		...(opts.endpointReady ? { endpointReady: opts.endpointReady } : {}),
		spawn: () => {
			const c = new FakeChild(undefined, opts.obeysShutdown ?? true)
			children.push(c)
			return c
		},
	})
	return { sup, children, audits, snaps, last: () => children[children.length - 1] as FakeChild }
}

const hello = (c: FakeChild, uses = ['os.foregroundWindow']) =>
	c.say({ t: 'hello', api: 1, version: '1', uses })

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('supervisor', () => {
	it('with an endpoint check, the first status does not report collecting until the endpoint is up', async () => {
		let open: (up: boolean) => void = () => {}
		const r = rig(manifest(), {
			endpointReady: () =>
				new Promise<boolean>((res) => {
					open = res
				}),
		})
		r.sup.start()
		hello(r.last())
		r.last().say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		expect(r.sup.snapshot().state).toBe('starting')
		expect(r.snaps.some((s) => s.state === 'collecting')).toBe(false)
		open(true)
		await Promise.resolve()
		expect(r.sup.snapshot().state).toBe('collecting')
		// Later statuses are not held again.
		r.last().say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		expect(r.sup.snapshot().state).toBe('collecting')
	})

	for (const answer of [false, true]) {
		it(`a stop during the endpoint wait stays stopped when the wait then answers ${answer}`, async () => {
			let settle: (up: boolean) => void = () => {}
			let signal: AbortSignal | undefined
			const r = rig(manifest(), {
				endpointReady: (s) => {
					signal = s
					return new Promise<boolean>((res) => {
						settle = res
					})
				},
			})
			r.sup.start()
			hello(r.last())
			r.last().say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
			expect(r.sup.snapshot().state).toBe('starting')
			const stopped = r.sup.stop()
			expect(signal?.aborted).toBe(true)
			r.last().exit(0, null)
			await stopped
			expect(r.sup.snapshot().state).toBe('stopped')
			settle(answer)
			await Promise.resolve()
			await Promise.resolve()
			// Nothing came back: no restart is armed and no running state was ever published.
			await vi.advanceTimersByTimeAsync(120_000)
			expect(r.children.length).toBe(1)
			expect(r.sup.snapshot().state).toBe('stopped')
			expect(r.snaps.some((s) => s.state === 'collecting')).toBe(false)
			expect(r.audits).not.toContain('failed:query endpoint did not open')
		})
	}

	it('an endpoint that never opens fails the start instead of reporting running', async () => {
		const r = rig(manifest(), { endpointReady: () => Promise.resolve(false) })
		r.sup.start()
		hello(r.last())
		r.last().say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		await Promise.resolve()
		await Promise.resolve()
		expect(r.snaps.some((s) => s.state === 'collecting')).toBe(false)
		expect(r.children[0]?.killed).toEqual([true])
		expect(r.audits).toContain('failed:query endpoint did not open')
	})

	it('starts, takes hello, acknowledges with the granted list, and reports collecting on the first status', () => {
		const r = rig(manifest())
		r.sup.start()
		expect(r.sup.snapshot().state).toBe('starting')
		hello(r.last())
		expect(r.last().written[0]).toContain('"hello-ack"')
		r.last().say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		expect(r.sup.snapshot().state).toBe('collecting')
	})

	it('no hello in 10 s is a failure; it restarts after the first backoff', () => {
		const r = rig(manifest())
		r.sup.start()
		vi.advanceTimersByTime(9_999)
		expect(r.children).toHaveLength(1)
		vi.advanceTimersByTime(1)
		expect(r.children[0]?.killed).toEqual([true])
		expect(r.children).toHaveLength(1)
		vi.advanceTimersByTime(999)
		expect(r.children).toHaveLength(1)
		vi.advanceTimersByTime(1)
		expect(r.children).toHaveLength(2)
	})

	it('backoff follows the manifest (1000, then 5000, then 5000) and the cap sets failed', () => {
		const r = rig(manifest())
		r.sup.start()
		const delays: number[] = []
		for (let i = 0; i < 3; i++) {
			r.last().exit(1)
			const before = r.children.length
			let waited = 0
			while (r.children.length === before && waited < 10_000) {
				vi.advanceTimersByTime(500)
				waited += 500
			}
			delays.push(waited)
		}
		expect(delays).toEqual([1000, 5000, 5000])
		// maxPerHour is 3: the fourth failure in the hour is over the cap.
		r.last().exit(1)
		expect(r.sup.snapshot().state).toBe('failed')
		expect(r.audits.some((a) => a.startsWith('failed:'))).toBe(true)
		vi.advanceTimersByTime(60_000)
		expect(r.children).toHaveLength(4)
	})

	it('a run longer than stableAfterMs resets the backoff', () => {
		const r = rig(
			manifest((m) => {
				m.entry.process.restart.maxPerHour = 20
			}),
		)
		r.sup.start()
		r.last().exit(1)
		vi.advanceTimersByTime(1000)
		r.last().exit(1)
		vi.advanceTimersByTime(5000)
		expect(r.children).toHaveLength(3)
		hello(r.last())
		for (let i = 0; i < 2; i++) {
			vi.advanceTimersByTime(30_500)
			r.last().say({ t: 'status', state: 'collecting' })
		}
		r.last().exit(1)
		let waited = 0
		const before = r.children.length
		while (r.children.length === before) {
			vi.advanceTimersByTime(500)
			waited += 500
		}
		expect(waited).toBe(1000)
	})

	it('an exit the host did not ask for counts as a failure even with code 0', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		r.last().exit(0)
		expect(r.audits.some((a) => a.startsWith('exited:code 0'))).toBe(true)
		expect(r.audits.some((a) => a.startsWith('restart:'))).toBe(true)
		vi.advanceTimersByTime(1000)
		expect(r.children).toHaveLength(2)
	})

	it('three missed heartbeats stop the process and mark it not responding while it waits to restart', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		r.last().say({ t: 'status', state: 'collecting' })
		vi.advanceTimersByTime(60_000)
		expect(r.children[0]?.killed).toEqual([])
		vi.advanceTimersByTime(30_000)
		expect(r.children[0]?.killed).toEqual([true])
		expect(r.sup.snapshot().state).toBe('not-responding')
	})

	it('a status keeps the heartbeat alive', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		for (let i = 0; i < 6; i++) {
			vi.advanceTimersByTime(30_000)
			r.last().say({ t: 'status', state: 'collecting' })
		}
		expect(r.children[0]?.killed).toEqual([])
	})

	it('a clean stop sends shutdown and resolves when the child exits', async () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		const done = r.sup.stop()
		await done
		expect(r.children[0]?.written.some((w) => w.includes('shutdown'))).toBe(true)
		expect(r.children[0]?.killed).toEqual([])
		expect(r.sup.snapshot().state).toBe('stopped')
	})

	it('a child that ignores shutdown is killed after the grace period', async () => {
		const r = rig(manifest(), { obeysShutdown: false })
		r.sup.start()
		hello(r.last())
		const done = r.sup.stop()
		vi.advanceTimersByTime(1999)
		expect(r.children[0]?.killed).toEqual([])
		vi.advanceTimersByTime(1)
		await done
		expect(r.children[0]?.killed).toEqual([true])
		expect(r.sup.snapshot().state).toBe('stopped')
	})

	it('hello naming an undeclared permission stops it as failed, without restart (R4)', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last(), ['os.foregroundWindow', 'os.clipboard'])
		expect(r.sup.snapshot()).toMatchObject({
			state: 'failed',
			failedReason: 'undeclared-permission',
		})
		expect(r.children[0]?.killed).toEqual([true])
		vi.advanceTimersByTime(60_000)
		expect(r.children).toHaveLength(1)
	})

	it('hello using an optional permission that was not granted is refused; once granted it is accepted (R4)', () => {
		const a = rig(manifest())
		a.sup.start()
		hello(a.last(), ['os.screenChange'])
		expect(a.sup.snapshot().failedReason).toBe('undeclared-permission')
		const b = rig(manifest(), { granted: ['os.screenChange'] })
		b.sup.start()
		hello(b.last(), ['os.screenChange'])
		expect(b.sup.snapshot().state).toBe('starting')
		expect(b.last().written[0]).toContain('os.screenChange')
	})

	it('three refused messages in a row stop it (R5), and a good status resets the count', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		r.last().say({ t: 'banana' })
		r.last().say('not json')
		r.last().say({ t: 'status', state: 'collecting' })
		r.last().say({ t: 'banana' })
		r.last().say({ t: 'banana' })
		expect(r.children[0]?.killed).toEqual([])
		r.last().say({ t: 'banana' })
		expect(r.children[0]?.killed).toEqual([true])
	})

	it('a line over 64 KiB is refused', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		r.last().say('x'.repeat(70_000))
		expect(r.audits.some((a) => a.includes('64 KiB'))).toBe(true)
	})

	it('a status state or signal the manifest did not declare shows as degraded (R6)', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		r.last().say({ t: 'status', state: 'collecting' })
		expect(r.sup.snapshot().state).toBe('collecting')
		r.last().say({ t: 'status', state: 'collecting', signals: { 'os.clipboard': 'ok' } })
		expect(r.sup.snapshot().state).toBe('degraded')
		r.last().say({ t: 'status', state: 'thriving' })
		expect(r.sup.snapshot().state).toBe('degraded')
	})

	it('reports collecting while hung, then flips to not-responding when the heartbeat stops (E20)', () => {
		const r = rig(manifest())
		r.sup.start()
		hello(r.last())
		r.last().say({ t: 'status', state: 'collecting' })
		expect(r.sup.snapshot().state).toBe('collecting')
		vi.advanceTimersByTime(90_000)
		expect(r.sup.snapshot().state).toBe('not-responding')
	})

	it('Start again after failed forgets the failures and starts', () => {
		const r = rig(manifest())
		r.sup.start()
		for (let i = 0; i < 3; i++) {
			r.last().exit(1)
			vi.advanceTimersByTime(5000)
		}
		r.last().exit(1)
		expect(r.sup.snapshot().state).toBe('failed')
		r.sup.startAgain()
		expect(r.sup.snapshot().state).toBe('starting')
		expect(r.children).toHaveLength(5)
	})

	it('policy never goes straight to failed', () => {
		const r = rig(
			manifest((m) => {
				m.entry.process.restart.policy = 'never'
			}),
		)
		r.sup.start()
		r.last().exit(1)
		expect(r.sup.snapshot().state).toBe('failed')
	})
})
