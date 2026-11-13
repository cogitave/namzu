import { describe, expect, it } from 'vitest'

import {
	DEFAULT_WHEEL,
	WHEEL_FEEL,
	WHEEL_IDLE,
	type WheelSettings,
	type WheelState,
	clampWheelRows,
	frame,
	notch,
	notchRows,
	settle,
} from './glide.js'

const WINDOW = 40
const PAGE = WINDOW - 1

/** Notches at the given times in ms, in the given directions. */
function feed(
	times: readonly number[],
	direction: 'up' | 'down' | readonly ('up' | 'down')[] = 'down',
	settings: WheelSettings = DEFAULT_WHEEL,
	start: WheelState = WHEEL_IDLE,
): WheelState {
	let state = start
	times.forEach((at, i) => {
		const d = typeof direction === 'string' ? direction : (direction[i] ?? 'down')
		state = notch(state, d, at, settings, WINDOW)
	})
	return state
}

/** Spend a distance frame by frame; the steps taken. */
function spend(state: WheelState, window = WINDOW): number[] {
	const steps: number[] = []
	let now = state
	for (let i = 0; i < 1000 && now.pending !== 0; i++) {
		const next = frame(now, window)
		steps.push(next.step)
		now = next.state
	}
	return steps
}

describe('a notch adds to a distance', () => {
	it('is the plain step for one slow notch', () => {
		expect(feed([0]).pending).toBe(WHEEL_FEEL.rows)
		expect(feed([0], 'up').pending).toBe(-WHEEL_FEEL.rows)
	})

	it('adds three slow notches, each a plain step', () => {
		const state = feed([0, 800, 1600])
		// Each one landed after a pause, so none is faster than the plain step.
		expect(state.pending).toBe(3 * WHEEL_FEEL.rows)
		expect(state.run).toBe(0)
	})

	it('adds two notches that arrive in one input chunk', () => {
		const state = feed([100, 100])
		expect(state.pending).toBeGreaterThanOrEqual(2 * WHEEL_FEEL.rows)
	})

	it('takes several reports of one turn of the wheel as the plain step each, not a fast run', () => {
		const three = feed([100, 100, 100])
		expect(three.pending).toBe(3 * WHEEL_FEEL.rows)
		expect(three.run).toBe(0)
		// A terminal that sends three reports per notch is set to one row a report.
		const one = feed([100, 100, 100], 'down', { rows: 1, accel: true })
		expect(one.pending).toBe(3)
		// The next turn of the wheel, a little later, is a fast run as before.
		expect(feed([100, 100, 100, 150]).run).toBe(1)
	})
})

describe('the frame period', () => {
	it('is clear of the renderer throttle, so each frame is painted on its own', () => {
		// The renderer paints at most 30 times a second (34 ms) through two throttles
		// in a row; a period at or near that merges two frames into one 68 ms paint.
		expect(WHEEL_FEEL.frameMs).toBeGreaterThanOrEqual(Math.ceil(1000 / 30) + 8)
	})
})

describe('a fast run speeds up', () => {
	const run = (n: number) => feed(Array.from({ length: n }, (_, i) => i * 50))

	it('moves more per notch the longer the run, up to a window less a row', () => {
		const per = Array.from({ length: 14 }, (_, i) => notchRows(i, DEFAULT_WHEEL, WINDOW))
		expect(per[0]).toBe(WHEEL_FEEL.rows)
		for (let i = 1; i < per.length; i++) expect(per[i]).toBeGreaterThanOrEqual(per[i - 1] ?? 0)
		expect(per[WHEEL_FEEL.fullRun]).toBe(PAGE)
		expect(per.at(-1)).toBe(PAGE)
		expect(Math.max(...per)).toBeLessThanOrEqual(PAGE)
	})

	it('travels farther for a run of ten than ten plain steps, but not more than ten windows', () => {
		const state = run(10)
		expect(state.pending).toBeGreaterThan(10 * WHEEL_FEEL.rows)
		expect(state.pending).toBeLessThanOrEqual(10 * PAGE)
	})

	it('returns to the plain step after a pause', () => {
		const fast = run(5)
		const after = notch(fast, 'down', (fast.at ?? 0) + WHEEL_FEEL.pauseMs, DEFAULT_WHEEL, WINDOW)
		expect(after.run).toBe(0)
		// A pause does not cut the distance still to travel: the glide finishes.
		expect(after.pending).toBe(fast.pending + WHEEL_FEEL.rows)
	})

	it('eases back halfway on a gap between a fast notch and a pause', () => {
		const fast = run(8)
		const after = notch(fast, 'down', (fast.at ?? 0) + 300, DEFAULT_WHEEL, WINDOW)
		expect(after.run).toBe(Math.floor(fast.run / 2))
	})

	it('is the plain step every time with the speed-up off', () => {
		const state = feed(
			Array.from({ length: 10 }, (_, i) => i * 50),
			'down',
			{ rows: 3, accel: false },
		)
		expect(state.pending).toBe(30)
	})
})

describe('direction', () => {
	it('drops the distance and starts a plain step on a change of direction', () => {
		const fast = feed(Array.from({ length: 10 }, (_, i) => i * 50))
		const first = notch(fast, 'up', (fast.at ?? 0) + 50, DEFAULT_WHEEL, WINDOW)
		const turned = notch(first, 'up', (first.at ?? 0) + 50, DEFAULT_WHEEL, WINDOW)
		expect(turned.pending).toBe(-WHEEL_FEEL.rows)
		expect(turned.run).toBe(0)
		expect(turned.dir).toBe(-1)
		// A change of direction without a run behind it is at once a turn.
		const slow = notch(feed([0]), 'up', 100, DEFAULT_WHEEL, WINDOW)
		expect(slow.pending).toBe(-WHEEL_FEEL.rows)
	})

	it('holds one stray notch the other way inside a fast run', () => {
		const fast = feed(Array.from({ length: 6 }, (_, i) => i * 50))
		const stray = notch(fast, 'up', (fast.at ?? 0) + 50, DEFAULT_WHEEL, WINDOW)
		// It moved nothing and the run is intact.
		expect(stray.pending).toBe(fast.pending)
		expect(stray.run).toBe(fast.run)
		const back = notch(stray, 'down', (stray.at ?? 0) + 50, DEFAULT_WHEEL, WINDOW)
		expect(back.pending).toBeGreaterThan(fast.pending)
		expect(back.run).toBe(fast.run + 1)
		expect(back.stray).toBeNull()
	})

	it('takes two notches the other way as a turn', () => {
		const fast = feed(Array.from({ length: 6 }, (_, i) => i * 50))
		const stray = notch(fast, 'up', (fast.at ?? 0) + 50, DEFAULT_WHEEL, WINDOW)
		const turned = notch(stray, 'up', (stray.at ?? 0) + 50, DEFAULT_WHEEL, WINDOW)
		expect(turned.pending).toBe(-WHEEL_FEEL.rows)
		expect(turned.dir).toBe(-1)
	})

	it('does not hold a notch the other way after a short run', () => {
		const short = feed([0, 50])
		const turned = notch(short, 'up', 100, DEFAULT_WHEEL, WINDOW)
		expect(turned.pending).toBe(-WHEEL_FEEL.rows)
	})
})

describe('spending the distance', () => {
	it('lands exactly, in a few frames, for one slow notch', () => {
		const steps = spend(feed([0]))
		expect(steps.reduce((a, b) => a + b, 0)).toBe(WHEEL_FEEL.rows)
		expect(steps.length).toBeLessThanOrEqual(3)
		// Frames never grow: the move slows into the stop.
		for (let i = 1; i < steps.length; i++)
			expect(steps[i] ?? 0).toBeLessThanOrEqual(steps[i - 1] ?? 0)
	})

	it('covers a large share first and all of a small remainder', () => {
		const state: WheelState = { ...WHEEL_IDLE, pending: 30 }
		const steps = spend(state)
		expect(steps[0]).toBe(15)
		expect(steps.reduce((a, b) => a + b, 0)).toBe(30)
		expect(steps.at(-1)).toBeLessThanOrEqual(WHEEL_FEEL.landRows)
	})

	it('keeps the distance within a few windows however fast the hand goes', () => {
		const state = feed(Array.from({ length: 200 }, (_, i) => i * 10))
		expect(state.pending).toBe(WHEEL_FEEL.maxAheadWindows * PAGE)
		expect(
			feed(
				Array.from({ length: 200 }, (_, i) => i * 10),
				'up',
			).pending,
		).toBe(-WHEEL_FEEL.maxAheadWindows * PAGE)
	})

	it('never moves more than a window less a row in one frame', () => {
		const steps = spend({ ...WHEEL_IDLE, pending: 5000 })
		expect(Math.max(...steps)).toBe(PAGE)
		expect(steps.reduce((a, b) => a + b, 0)).toBe(5000)
	})

	it('keeps the sign of an upward distance', () => {
		const steps = spend({ ...WHEEL_IDLE, pending: -9 })
		expect(steps.every((s) => s < 0)).toBe(true)
		expect(steps.reduce((a, b) => a + b, 0)).toBe(-9)
	})

	it('stops when it is settled, as at the top or the bottom', () => {
		const mid = frame({ ...WHEEL_IDLE, pending: 30 }, WINDOW).state
		expect(settle(mid).pending).toBe(0)
		expect(frame(settle(mid), WINDOW).step).toBe(0)
	})

	it('moves a tiny window by a row at a time', () => {
		const steps = spend({ ...WHEEL_IDLE, pending: 12 }, 3)
		expect(Math.max(...steps)).toBeLessThanOrEqual(2)
		expect(steps.reduce((a, b) => a + b, 0)).toBe(12)
	})
})

describe('the rows setting', () => {
	it('is kept from 1 to 20', () => {
		expect(clampWheelRows(0)).toBe(1)
		expect(clampWheelRows(99)).toBe(20)
		expect(clampWheelRows(7)).toBe(7)
		expect(clampWheelRows(Number.NaN)).toBe(WHEEL_FEEL.rows)
	})

	it('sets the plain step, and the run still rises to a window less a row', () => {
		const settings = { rows: 1, accel: true }
		expect(notchRows(0, settings, WINDOW)).toBe(1)
		expect(notchRows(WHEEL_FEEL.fullRun, settings, WINDOW)).toBe(PAGE)
		expect(feed([0], 'down', { rows: 12, accel: true }).pending).toBe(12)
	})
})
