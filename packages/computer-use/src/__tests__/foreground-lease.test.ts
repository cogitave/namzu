import { describe, expect, it } from 'vitest'
import { ScreenLease } from '../foreground/lease.js'
import { FakeClock, memoryLeaseFs } from './foreground-fakes.js'

const PATH = '/home/.namzu/computer-use/screen.lease'

function lease(
	fs: ReturnType<typeof memoryLeaseFs>,
	clock: FakeClock,
	over: {
		pid: number
		session: string
		alive?: (pid: number) => boolean
		identity?: (pid: number) => string | undefined
	},
) {
	return new ScreenLease({
		path: PATH,
		session: over.session,
		now: () => clock.now(),
		fs,
		pid: over.pid,
		identity: over.identity ?? ((pid) => `t${pid}`),
		alive: over.alive ?? (() => true),
		ttlMs: 30_000,
	})
}

describe('the screen lease', () => {
	it('is held by one session at a time and shows who holds it', () => {
		const fs = memoryLeaseFs()
		const clock = new FakeClock()
		const a = lease(fs, clock, { pid: 1, session: 'a' })
		const b = lease(fs, clock, { pid: 2, session: 'b' })
		const first = a.tryAcquire()
		expect(first.held).toBe(true)
		const second = b.tryAcquire()
		expect(second).toMatchObject({
			held: false,
			owner: { pid: 1, session: 'a' },
		})
	})

	it('is released by its owner only', () => {
		const fs = memoryLeaseFs()
		const clock = new FakeClock()
		const a = lease(fs, clock, { pid: 1, session: 'a' })
		const b = lease(fs, clock, { pid: 2, session: 'b' })
		const held = a.tryAcquire()
		if (!held.held) throw new Error('not held')
		b.release('not-the-token')
		expect(fs.files.has(PATH)).toBe(true)
		a.release(held.token)
		expect(fs.files.has(PATH)).toBe(false)
		expect(b.tryAcquire().held).toBe(true)
	})

	it('is taken over when its owner process is gone', () => {
		const fs = memoryLeaseFs()
		const clock = new FakeClock()
		lease(fs, clock, { pid: 1, session: 'a' }).tryAcquire()
		const b = lease(fs, clock, {
			pid: 2,
			session: 'b',
			alive: (pid) => pid !== 1,
		})
		expect(b.tryAcquire().held).toBe(true)
		expect(b.read()?.session).toBe('b')
	})

	it('is taken over when the process id now belongs to a process that started later', () => {
		const fs = memoryLeaseFs()
		const clock = new FakeClock()
		lease(fs, clock, {
			pid: 1,
			session: 'a',
			identity: () => 'boot-1',
		}).tryAcquire()
		const b = lease(fs, clock, {
			pid: 2,
			session: 'b',
			identity: (pid) => (pid === 1 ? 'boot-2' : 'mine'),
		})
		expect(b.tryAcquire().held).toBe(true)
	})

	it('is taken over when nobody refreshed it within the time to live, and a refresh keeps it', () => {
		const fs = memoryLeaseFs()
		const clock = new FakeClock()
		const a = lease(fs, clock, { pid: 1, session: 'a' })
		const held = a.tryAcquire()
		if (!held.held) throw new Error('not held')
		const b = lease(fs, clock, { pid: 2, session: 'b' })
		clock.time += 29_000
		expect(a.heartbeat(held.token)).toBe(true)
		clock.time += 29_000
		expect(b.tryAcquire().held).toBe(false)
		clock.time += 2_000
		expect(b.tryAcquire().held).toBe(true)
		expect(a.heartbeat(held.token)).toBe(false)
	})

	it('treats a half-written file as stale', () => {
		const fs = memoryLeaseFs()
		const clock = new FakeClock()
		fs.files.set(PATH, '{"pid":')
		expect(lease(fs, clock, { pid: 2, session: 'b' }).tryAcquire().held).toBe(true)
	})
})
