/**
 * How the wheel moves the fullscreen view: every notch adds to a distance still
 * to travel, a fast run of notches adds more per notch, and the view spends the
 * distance over the next few frames. Pure arithmetic over a state and a clock
 * reading, so the table of cases is tested without a terminal or a timer.
 *
 * Every number that sets the feel is in `WHEEL_FEEL`; nothing else in the code
 * and no test repeats them.
 */

import { pageRows } from './viewport.js'

/** The numbers that set how the wheel feels. The docs carry the same table. */
export const WHEEL_FEEL = {
	/** Rows a slow notch moves (`tui.wheelRows` replaces it). */
	rows: 3,
	/** Fewest and most rows a notch may be set to. */
	minRows: 1,
	maxRows: 20,
	/** Notches closer together than this belong to one fast run. */
	runGapMs: 120,
	/**
	 * Reports this close together are one turn of the wheel: a terminal that sends
	 * several reports per notch sends them in one write. They add the plain step
	 * each and do not count as a faster run.
	 */
	burstMs: 2,
	/** A gap this long or longer ends the run: the next notch is a plain step. */
	pauseMs: 500,
	/** Notches in a run at which a notch has reached its ceiling of one window less a row. */
	fullRun: 9,
	/** A run this long may have one stray notch the other way without losing it. */
	bounceRun: 3,
	/** The distance to travel never runs more than this many windows ahead of the view, so it stops soon after the hand does. */
	maxAheadWindows: 4,
	/** The share of the distance left that one frame covers. */
	share: 0.5,
	/** At or under this many rows left, one frame covers all of it and lands exactly. */
	landRows: 2,
	/**
	 * Milliseconds between frames while a distance remains. The renderer paints at
	 * most 30 times a second through two throttles in a row, so a frame at its own
	 * rate can land inside the window and wait for the next: 68 ms painted, two
	 * frames in one paint. A frame period this much longer than 34 ms paints each
	 * frame on its own.
	 */
	frameMs: 44,
} as const

export interface WheelSettings {
	/** Rows a slow notch moves. */
	readonly rows: number
	/** A fast run speeds up; off, every notch is the plain step. */
	readonly accel: boolean
}

export const DEFAULT_WHEEL: WheelSettings = { rows: WHEEL_FEEL.rows, accel: true }

/** The rows a setting asks for, kept inside what is allowed. */
export function clampWheelRows(rows: number): number {
	if (!Number.isFinite(rows)) return WHEEL_FEEL.rows
	return Math.min(WHEEL_FEEL.maxRows, Math.max(WHEEL_FEEL.minRows, Math.round(rows)))
}

export interface WheelState {
	/** Signed rows still to travel: down is positive. */
	readonly pending: number
	/** Fast notches in a row, before this one. */
	readonly run: number
	/** The direction of the run; 0 before the first notch. */
	readonly dir: -1 | 0 | 1
	/** When the last notch arrived; null before the first. */
	readonly at: number | null
	/** A single notch the other way inside a run, held back until the next notch says what it was. */
	readonly stray: -1 | 1 | null
}

export const WHEEL_IDLE: WheelState = { pending: 0, run: 0, dir: 0, at: null, stray: null }

/** Rows one notch moves in a run of `run` notches: the plain step, rising smoothly to a window less a row. */
export function notchRows(run: number, settings: WheelSettings, window: number): number {
	const base = clampWheelRows(settings.rows)
	if (!settings.accel) return base
	const ceiling = Math.max(base, pageRows(window))
	const t = Math.min(1, Math.max(0, run) / WHEEL_FEEL.fullRun)
	return Math.round(base + (ceiling - base) * t * t)
}

/**
 * One notch. `window` is the rows the view shows. Several notches in one input
 * chunk are several calls with the same `now`, and they add up.
 */
export function notch(
	state: WheelState,
	direction: 'up' | 'down',
	now: number,
	settings: WheelSettings,
	window: number,
): WheelState {
	const dir = direction === 'up' ? -1 : 1
	const gap = state.at === null ? Number.POSITIVE_INFINITY : Math.max(0, now - state.at)
	let { run, pending } = state
	let stray: -1 | 1 | null = state.stray

	if (gap >= WHEEL_FEEL.pauseMs || state.dir === 0) {
		run = 0
		stray = null
	} else if (dir !== state.dir) {
		const bounce =
			settings.accel &&
			state.stray === null &&
			state.run >= WHEEL_FEEL.bounceRun &&
			gap <= WHEEL_FEEL.runGapMs
		if (bounce) return { ...state, at: now, stray: dir }
		// A real turn: the distance to travel the old way is let go, and this is a plain step.
		run = 0
		pending = 0
		stray = null
	} else {
		stray = null
		run =
			gap <= WHEEL_FEEL.burstMs
				? state.run
				: gap <= WHEEL_FEEL.runGapMs
					? state.run + 1
					: Math.floor(state.run / 2)
	}
	const rows = notchRows(run, settings, window)
	const ahead = Math.max(rows, WHEEL_FEEL.maxAheadWindows * pageRows(window))
	const total = Math.max(-ahead, Math.min(ahead, pending + dir * rows))
	return { pending: total, run, dir, at: now, stray }
}

/**
 * The next frame of a glide: how many rows (signed) the view moves now, and the
 * state after. A large distance is covered by shares; a small one all at once,
 * so the last frame lands exactly. One frame never moves more than a window
 * less a row.
 */
export function frame(state: WheelState, window: number): { step: number; state: WheelState } {
	const left = Math.abs(state.pending)
	if (left === 0) return { step: 0, state }
	const sign = state.pending < 0 ? -1 : 1
	const cap = pageRows(window)
	const rows =
		left <= WHEEL_FEEL.landRows
			? left
			: Math.min(cap, Math.max(1, Math.ceil(left * WHEEL_FEEL.share)))
	const step = Math.min(rows, left)
	return { step: sign * step, state: { ...state, pending: state.pending - sign * step } }
}

/** The state with nothing left to travel: the run and direction are kept. */
export function settle(state: WheelState): WheelState {
	return state.pending === 0 ? state : { ...state, pending: 0 }
}
