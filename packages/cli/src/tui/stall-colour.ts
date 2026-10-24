/**
 * The "this is slow" tint on the Working label. With no token for more than
 * 10 s the label blends toward `rgb(171,43,63)`, fully at 20 s, eased so it
 * never jumps; never while a tool runs, the model is thinking, a compaction
 * runs or the turn is paused on the person; back to normal on the next token.
 * Pure; the clock is passed in.
 */

export const STALL_START_MS = 10_000
export const STALL_FULL_MS = 20_000
export const STALL_RGB: readonly [number, number, number] = [171, 43, 63]
/** Each 50 ms step closes 10% of the distance to the target. */
const EASE_STEP_MS = 50
const EASE_RATE = 0.1

/** Where the tint is heading: 0 (none) to 1 (full). */
export function stallTarget(input: {
	readonly sinceLastTokenMs: number
	readonly exempt: boolean
}): number {
	if (input.exempt) return 0
	const raw = (input.sinceLastTokenMs - STALL_START_MS) / (STALL_FULL_MS - STALL_START_MS)
	return Math.min(1, Math.max(0, raw))
}

/** Move `current` toward `target` by the 10%-per-50 ms rule over `elapsedMs`. */
export function easeStall(current: number, target: number, elapsedMs: number): number {
	const steps = Math.max(0, Math.floor(elapsedMs / EASE_STEP_MS))
	if (steps === 0) return current
	const remaining = (1 - EASE_RATE) ** steps
	const next = target + (current - target) * remaining
	return Math.abs(next - target) < 0.005 ? target : next
}

/** `rgb(r,g,b)` for the Ink colour prop: `base` blended toward the stall red by `amount`. */
export function blendTowardStall(base: readonly [number, number, number], amount: number): string {
	const t = Math.min(1, Math.max(0, amount))
	const channel = (i: 0 | 1 | 2): number => Math.round(base[i] + (STALL_RGB[i] - base[i]) * t)
	return `rgb(${channel(0)},${channel(1)},${channel(2)})`
}
