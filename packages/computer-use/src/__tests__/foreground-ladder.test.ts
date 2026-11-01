import { describe, expect, it, vi } from 'vitest'
import { STOPPED_TEXT } from '../foreground/ladder.js'
import { BurstInterrupted } from '../foreground/types.js'
import { FakeClock, FakeMonitor, baseState, makeLadder } from './foreground-fakes.js'

const SUBJECT = { app: 'Notepad', exe: 'notepad.exe', pid: 77 }

describe('the foreground ladder', () => {
	it('runs a burst at once when the user has been still, then puts things back', async () => {
		const { ladder, monitor, fs } = makeLadder()
		const burst = vi.fn(async () => 'sent')
		const outcome = await ladder.run({ subject: SUBJECT }, burst)
		expect(outcome).toMatchObject({
			kind: 'ran',
			value: 'sent',
			interfered: false,
			stopped: false,
		})
		expect(monitor.calls).toEqual(['state', 'begin', 'end'])
		expect(monitor.ends).toEqual([{ restore: true }])
		expect(fs.files.size).toBe(0)
		expect(monitor.released).toHaveLength(1)
	})

	it('brings the target window to the front first, so a driver that may not take focus finds it there', async () => {
		const { ladder, monitor } = makeLadder()
		await ladder.run({ subject: { ...SUBJECT, hwnd: '0x3dc09a0' } }, async () => 1)
		await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(monitor.begins).toEqual([{ raise: '0x3dc09a0' }, {}])
	})

	it('leaves the cursor where a mouse_move put it', async () => {
		const { ladder, monitor } = makeLadder()
		await ladder.run({ subject: SUBJECT, keepCursor: true }, async () => 1)
		expect(monitor.ends).toEqual([{ restore: true, keepCursor: true }])
	})

	it('waits for the user to be still, polling, and then runs', async () => {
		const clock = new FakeClock()
		const start = clock.time
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({
			...baseState,
			userIdleMs: clock.time - start >= 3_000 ? 2_500 : 100,
		})
		const { ladder } = makeLadder({ monitor, clock })
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 'ok')
		expect(outcome.kind).toBe('ran')
		expect(clock.time - start).toBeGreaterThanOrEqual(3_000)
		expect(clock.time - start).toBeLessThan(15_000)
	})

	it('asks the user once after the wait, and runs after a yes, remembering the app', async () => {
		const clock = new FakeClock()
		const start = clock.time
		const monitor = new FakeMonitor()
		// Busy for 20 s, then a pause of 600 ms that is enough once they agreed.
		monitor.state_ = () => ({
			...baseState,
			userIdleMs: clock.time - start > 20_000 ? 600 : 0,
		})
		const approve = vi.fn(async () => 'allow' as const)
		const { ladder } = makeLadder({ monitor, clock, approve })
		const first = await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(first.kind).toBe('ran')
		expect(approve).toHaveBeenCalledTimes(1)
		expect(approve).toHaveBeenCalledWith(
			expect.objectContaining({ app: 'Notepad', exe: 'notepad.exe' }),
			undefined,
		)
		expect(clock.time - start).toBeGreaterThanOrEqual(15_000)
		// The second burst for the same app is not asked about again.
		monitor.state_ = () => ({ ...baseState, userIdleMs: 600 })
		const second = await ladder.run({ subject: SUBJECT }, async () => 2)
		expect(second.kind).toBe('ran')
		expect(approve).toHaveBeenCalledTimes(1)
	})

	it('refuses without sending when the user says no, and does not ask again this turn', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, userIdleMs: 0 })
		const approve = vi.fn(async () => 'deny' as const)
		const { ladder } = makeLadder({ monitor, approve })
		ladder.beginTurn('t1')
		const burst = vi.fn(async () => 1)
		const one = await ladder.run({ subject: SUBJECT }, burst)
		const two = await ladder.run({ subject: SUBJECT }, burst)
		expect(one).toMatchObject({ kind: 'blocked', block: { code: 'declined' } })
		expect(two).toMatchObject({ kind: 'blocked', block: { code: 'declined' } })
		expect(approve).toHaveBeenCalledTimes(1)
		expect(burst).not.toHaveBeenCalled()
		// A new turn is a new chance to ask.
		ladder.beginTurn('t2')
		await ladder.run({ subject: SUBJECT }, burst)
		expect(approve).toHaveBeenCalledTimes(2)
	})

	it('names what blocks it when the user stays busy even after agreeing', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, userIdleMs: 0 })
		const clock = new FakeClock()
		const start = clock.time
		const { ladder } = makeLadder({
			monitor,
			clock,
			approve: async () => 'allow',
		})
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(outcome).toMatchObject({
			kind: 'blocked',
			block: { code: 'user_active' },
		})
		if (outcome.kind === 'blocked') expect(outcome.block.detail).toMatch(/nothing was sent/)
		// 15 s before the question plus 30 s after: bounded.
		expect(clock.time - start).toBeLessThanOrEqual(46_000)
	})

	it('parks and retries within a bound when nobody can be asked, then says what blocks', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, userIdleMs: 0 })
		const clock = new FakeClock()
		const start = clock.time
		const approve = vi.fn(async () => 'unavailable' as const)
		const { ladder } = makeLadder({ monitor, clock, approve })
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(outcome).toMatchObject({
			kind: 'blocked',
			block: { code: 'user_active' },
		})
		expect(approve).toHaveBeenCalledTimes(1)
		const waited = clock.time - start
		expect(waited).toBeGreaterThanOrEqual(120_000)
		expect(waited).toBeLessThan(140_000)
	})

	it('succeeds in a parked run when a still moment comes', async () => {
		const clock = new FakeClock()
		const start = clock.time
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({
			...baseState,
			userIdleMs: clock.time - start > 60_000 ? 5_000 : 0,
		})
		const { ladder } = makeLadder({ monitor, clock })
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 'done')
		expect(outcome).toMatchObject({ kind: 'ran', value: 'done' })
	})

	it('waits for another session to release the screen, then says so after a bound', async () => {
		const fs = (await import('./foreground-fakes.js')).memoryLeaseFs()
		const clock = new FakeClock()
		const a = makeLadder({ fs, clock, session: 'a', pid: 1 })
		const b = makeLadder({ fs, clock, session: 'b', pid: 2 })
		// A holds the lease while B asks.
		const held = a.lease.tryAcquire()
		expect(held.held).toBe(true)
		const outcome = await b.ladder.run({ subject: SUBJECT }, async () => 1)
		expect(outcome).toMatchObject({
			kind: 'blocked',
			block: { code: 'lease_busy' },
		})
	})

	it('takes over the lease of a session that died', async () => {
		const fs = (await import('./foreground-fakes.js')).memoryLeaseFs()
		const clock = new FakeClock()
		const a = makeLadder({ fs, clock, session: 'a', pid: 1 })
		a.lease.tryAcquire()
		const b = makeLadder({
			fs,
			clock,
			session: 'b',
			pid: 2,
			alive: (pid) => pid !== 1,
		})
		const outcome = await b.ladder.run({ subject: SUBJECT }, async () => 1)
		expect(outcome.kind).toBe('ran')
	})

	it('releases the lease when the burst throws', async () => {
		const { ladder, fs, monitor } = makeLadder()
		await expect(
			ladder.run({ subject: SUBJECT }, async () => {
				throw new Error('driver died')
			}),
		).rejects.toThrow('driver died')
		expect(fs.files.size).toBe(0)
		expect(monitor.calls.at(-1)).toBe('end')
	})

	it('reports input during the burst as interference', async () => {
		const { ladder, monitor } = makeLadder()
		monitor.during = { inputs: 3, escapes: 0 }
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 'x')
		expect(outcome).toMatchObject({
			kind: 'ran',
			interfered: true,
			stopped: false,
			restoredForeground: false,
		})
	})

	it('does not start when input arrived between the last look and the start, and looks again', async () => {
		const { ladder, monitor } = makeLadder()
		let begins = 0
		monitor.beginState = () => ({
			...baseState,
			userInputs: begins++ === 0 ? 1 : 0,
		})
		const burst = vi.fn(async () => 'x')
		const outcome = await ladder.run({ subject: SUBJECT }, burst)
		expect(outcome.kind).toBe('ran')
		expect(burst).toHaveBeenCalledTimes(1)
		expect(monitor.ends[0]).toEqual({ restore: false })
	})

	it('gives up with a name for the blocker when input keeps arriving at the start', async () => {
		const { ladder, monitor } = makeLadder()
		let n = 0
		monitor.beginState = () => ({ ...baseState, userInputs: ++n })
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 'x')
		expect(outcome).toMatchObject({
			kind: 'blocked',
			block: { code: 'user_active' },
		})
	})

	it('lets a burst step stop before it sends when the user touches input (checkpoint)', async () => {
		const { ladder, monitor } = makeLadder()
		let reads = 0
		monitor.state_ = (n) => ({ ...baseState, userInputs: n === 0 ? 0 : reads })
		const sent: string[] = []
		const outcome = await ladder.run({ subject: SUBJECT }, async (burst) => {
			sent.push('first')
			reads = 1
			try {
				await burst.checkpoint()
				sent.push('second')
			} catch (error) {
				expect(error).toBeInstanceOf(BurstInterrupted)
			}
			return sent
		})
		expect(outcome).toMatchObject({ kind: 'ran', value: ['first'] })
	})

	it('stops the turn on a physical Escape, and every later call is refused until a new turn', async () => {
		const { ladder, monitor } = makeLadder()
		ladder.beginTurn('t1')
		monitor.during = { inputs: 1, escapes: 1 }
		const first = await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(first).toMatchObject({ kind: 'ran', stopped: true })
		expect(ladder.stopped).toBe(true)
		monitor.during = { inputs: 0, escapes: 0 }
		const burst = vi.fn(async () => 1)
		const second = await ladder.run({ subject: SUBJECT }, burst)
		expect(second).toMatchObject({
			kind: 'blocked',
			block: { code: 'stopped', detail: STOPPED_TEXT },
		})
		expect(burst).not.toHaveBeenCalled()
		ladder.beginTurn('t1')
		expect(ladder.stopped).toBe(true)
		ladder.beginTurn('t2')
		expect(ladder.stopped).toBe(false)
	})

	it('refuses a burst when real input cannot be observed', async () => {
		const monitor = new FakeMonitor()
		monitor.startError = new Error('SetWindowsHookEx failed 5')
		const { ladder } = makeLadder({ monitor })
		const burst = vi.fn(async () => 1)
		const outcome = await ladder.run({ subject: SUBJECT }, burst)
		expect(outcome).toMatchObject({
			kind: 'blocked',
			block: { code: 'monitor_unavailable' },
		})
		expect(burst).not.toHaveBeenCalled()
		expect(monitor.disposed).toBe(1)
	})

	it.each([
		['lockapp.exe', 'locked_desktop'],
		['LogonUI.exe', 'locked_desktop'],
		['winlogon.exe', 'locked_desktop'],
		['consent.exe', 'uac_prompt'],
	])('will not drive %s in the foreground', async (exe, code) => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({
			...baseState,
			foreground: { hwnd: '0x1', pid: 4, exe, elevated: true },
		})
		const { ladder } = makeLadder({ monitor })
		const burst = vi.fn(async () => 1)
		const outcome = await ladder.run({ subject: SUBJECT }, burst)
		expect(outcome).toMatchObject({ kind: 'blocked', block: { code } })
		if (outcome.kind === 'blocked')
			expect(outcome.block.detail).toMatch(/never try to work around|Do not try to work around/i)
		expect(burst).not.toHaveBeenCalled()
	})

	it('will not act while another desktop (a secure prompt) has the input', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, desktop: 'Winlogon' })
		const { ladder } = makeLadder({ monitor })
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(outcome).toMatchObject({
			kind: 'blocked',
			block: { code: 'secure_desktop' },
		})
	})

	it('names an administrator-rights target instead of sending input that would be dropped', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({
			...baseState,
			target: { exe: 'regedit.exe', elevated: true },
		})
		const { ladder } = makeLadder({ monitor })
		const outcome = await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(outcome).toMatchObject({
			kind: 'blocked',
			block: { code: 'elevated_target' },
		})
		// From an administrator process the same target is fine.
		monitor.state_ = () => ({
			...baseState,
			selfElevated: true,
			target: { exe: 'regedit.exe', elevated: true },
		})
		expect((await ladder.run({ subject: SUBJECT }, async () => 1)).kind).toBe('ran')
	})

	it('will not try to replace a window in front that belongs to a program with higher rights', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({
			...baseState,
			foreground: { hwnd: '0x9', pid: 9, exe: '', elevated: true },
		})
		const { ladder } = makeLadder({ monitor })
		const burst = vi.fn(async () => 1)
		const outcome = await ladder.run({ subject: { ...SUBJECT, hwnd: '0x5' } }, burst)
		expect(outcome).toMatchObject({ kind: 'blocked', block: { code: 'elevated_target' } })
		if (outcome.kind === 'blocked') expect(outcome.block.detail).toMatch(/click away/)
		expect(burst).not.toHaveBeenCalled()
	})

	it('asks about the program in front when the burst is for the desktop as such', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({
			...baseState,
			userIdleMs: 0,
			foreground: { hwnd: '0x2', pid: 9, exe: 'paint.exe', elevated: false },
		})
		const approve = vi.fn(async () => 'deny' as const)
		const { ladder } = makeLadder({ monitor, approve })
		await ladder.run({ subject: { app: 'the desktop' } }, async () => 1)
		expect(approve).toHaveBeenCalledWith(
			expect.objectContaining({ app: 'paint', exe: 'paint.exe' }),
			undefined,
		)
	})

	it('releases the monitor at the end of the turn and starts a fresh one for the next burst', async () => {
		const { ladder, monitor } = makeLadder()
		await ladder.run({ subject: SUBJECT }, async () => 1)
		await ladder.endTurn()
		expect(monitor.disposed).toBe(1)
		await ladder.run({ subject: SUBJECT }, async () => 1)
		expect(monitor.started).toBe(2)
	})

	it('runs bursts one at a time', async () => {
		const { ladder } = makeLadder()
		const order: string[] = []
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const a = ladder.run({ subject: SUBJECT }, async () => {
			order.push('a:start')
			await gate
			order.push('a:end')
		})
		const b = ladder.run({ subject: SUBJECT }, async () => {
			order.push('b:start')
		})
		await Promise.resolve()
		release()
		await Promise.all([a, b])
		expect(order).toEqual(['a:start', 'a:end', 'b:start'])
	})
})
