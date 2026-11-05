/**
 * The numbers and the small maths of the presence overlay's motion. The helper
 * script is C# inside a string and cannot be unit-tested from here, so the
 * constants live here and are written into it, and the formulas are written
 * once more in plain TypeScript as the reference the tests pin; the C# in
 * `helper-script.ts` follows them line for line.
 *
 * Sizes are in logical pixels: the helper multiplies them by the operated
 * window's display scale (its DPI divided by 96).
 */

/** The shortest glide, for a pointer that has hardly to move. */
export const GLIDE_MIN_MS = 140
/** The longest glide, however far the pointer goes. */
export const GLIDE_MAX_MS = 420
/** Added to the shortest glide per logical pixel travelled, up to the longest. */
export const GLIDE_MS_PER_PX = 0.45
/** How far the path bows away from a straight line, as a fraction of its length. */
export const GLIDE_BOW = 0.1

/** The first appearance in a window: fade in and grow from {@link APPEAR_FROM_SCALE}. */
export const APPEAR_MS = 160
export const APPEAR_FROM_SCALE = 0.85

/** How long the pointer and frame stay after the last action, then fade. */
export const HOLD_MS = 2_000
export const FADE_MS = 500

/** A click: the pointer dips to {@link DIP_SCALE} and returns. */
export const DIP_SCALE = 0.88
export const DIP_DOWN_MS = 70
export const DIP_UP_MS = 110

/** The ripple around the tip: a click's, then a key press's (smaller and softer). */
export const RIPPLE_MS = 420
export const CLICK_RIPPLE = { from: 5, to: 26, alpha: 0.55, stroke: 2 } as const
export const KEY_RIPPLE = { from: 4, to: 14, alpha: 0.35, stroke: 1.5 } as const

/** The frame breathes by this fraction of its opacity over this period. */
export const FRAME_PULSE_MS = 2_400
export const FRAME_PULSE_DEPTH = 0.08

export interface Point {
	readonly x: number
	readonly y: number
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Slow, fast, slow: the glide's timing curve. `u` runs 0 to 1. */
export function easeInOut(u: number): number {
	const t = clamp(u, 0, 1)
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

/** Fast, then settling: the ripple's and the appearance's curve. */
export function easeOut(u: number): number {
	return 1 - (1 - clamp(u, 0, 1)) ** 3
}

/** How long a glide over `logicalDistance` pixels takes, in whole milliseconds. */
export function glideDurationMs(logicalDistance: number): number {
	return Math.round(
		clamp(GLIDE_MIN_MS + logicalDistance * GLIDE_MS_PER_PX, GLIDE_MIN_MS, GLIDE_MAX_MS),
	)
}

/**
 * The control point of the glide's quadratic curve: the middle of the path,
 * moved sideways by {@link GLIDE_BOW} of its length. The side depends on the
 * line alone, never on which way it is travelled (up on the screen; to the
 * right for a vertical line), so going to a point and back bows to the same
 * side both times instead of zigzagging.
 */
export function glideControl(from: Point, to: Point): Point {
	const dx = to.x - from.x
	const dy = to.y - from.y
	const len = Math.hypot(dx, dy)
	const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
	if (len < 1e-9) return mid
	let nx = -dy / len
	let ny = dx / len
	if (ny > 1e-9 || (Math.abs(ny) <= 1e-9 && nx < 0)) {
		nx = -nx
		ny = -ny
	}
	return { x: mid.x + nx * len * GLIDE_BOW, y: mid.y + ny * len * GLIDE_BOW }
}

/** The point at `t` (0 to 1) on the quadratic curve from `from` through `control` to `to`. */
export function glidePoint(from: Point, control: Point, to: Point, t: number): Point {
	const b = 1 - t
	return {
		x: b * b * from.x + 2 * b * t * control.x + t * t * to.x,
		y: b * b * from.y + 2 * b * t * control.y + t * t * to.y,
	}
}

/** The pointer's scale `ms` after a click lands: 1, dipping to {@link DIP_SCALE}, back to 1. */
export function dipScale(ms: number): number {
	if (ms < 0 || ms >= DIP_DOWN_MS + DIP_UP_MS) return 1
	if (ms < DIP_DOWN_MS) return 1 - (1 - DIP_SCALE) * easeOut(ms / DIP_DOWN_MS)
	return DIP_SCALE + (1 - DIP_SCALE) * easeOut((ms - DIP_DOWN_MS) / DIP_UP_MS)
}

export interface RippleFrame {
	/** Logical pixels from the tip. */
	readonly radius: number
	/** 0 to 1. */
	readonly alpha: number
	/** Logical pixels. */
	readonly stroke: number
}

/** The ripple `ms` after the action lands, or undefined before it and once it has faded. */
export function rippleFrame(kind: 'click' | 'type', ms: number): RippleFrame | undefined {
	if (ms < 0 || ms >= RIPPLE_MS) return undefined
	const spec = kind === 'click' ? CLICK_RIPPLE : KEY_RIPPLE
	const p = ms / RIPPLE_MS
	return {
		radius: spec.from + (spec.to - spec.from) * easeOut(p),
		alpha: spec.alpha * (1 - p),
		stroke: spec.stroke,
	}
}

/** The frame's opacity factor at `ms`: it breathes between 1 and 1 minus twice the depth. */
export function framePulse(ms: number): number {
	return 1 - FRAME_PULSE_DEPTH + FRAME_PULSE_DEPTH * Math.sin((2 * Math.PI * ms) / FRAME_PULSE_MS)
}

/** How opaque the overlay is `msSinceLastAction` after the last action: whole, then fading to nothing. */
export function idleAlpha(msSinceLastAction: number): number {
	if (msSinceLastAction <= HOLD_MS) return 1
	return clamp(1 - (msSinceLastAction - HOLD_MS) / FADE_MS, 0, 1)
}

/** The display scale for a window: its DPI over the 96 of an unscaled display. */
export function displayScale(dpi: number): number {
	return dpi > 0 ? dpi / 96 : 1
}
