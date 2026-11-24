/**
 * Resize settling for the fullscreen view.
 *
 * A resize leaves Ink's line diff out of step with the terminal, so one empty
 * frame is drawn once the size has stopped changing, and the next frame is
 * drawn whole. The empty frame is never drawn while resize events keep
 * arriving: a window drag sends them faster than any fixed wait, and blanking
 * on every event would leave the screen black for the whole drag. During the
 * drag the renderer keeps drawing real frames at the new size.
 */

/** Quiet time after the last size change before the clean-slate frame. */
export const FULLSCREEN_RESIZE_QUIET_MS = 250

/** Longer than the renderer's frame interval, so the empty frame is drawn. */
export const FULLSCREEN_RESIZE_BLANK_MS = 60

export interface ResizeSettler {
	/** A size change was seen. Cancels a pending or showing blank and waits for quiet. */
	resized(): void
	dispose(): void
}

export function createResizeSettler(
	setBlank: (blank: boolean) => void,
	timers: {
		set: (fn: () => void, ms: number) => unknown
		clear: (handle: unknown) => void
	} = {
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	},
): ResizeSettler {
	let handle: unknown
	let blank = false
	const cancel = () => {
		if (handle !== undefined) timers.clear(handle)
		handle = undefined
	}
	return {
		resized() {
			cancel()
			if (blank) {
				blank = false
				setBlank(false)
			}
			handle = timers.set(() => {
				blank = true
				setBlank(true)
				handle = timers.set(() => {
					handle = undefined
					blank = false
					setBlank(false)
				}, FULLSCREEN_RESIZE_BLANK_MS)
			}, FULLSCREEN_RESIZE_QUIET_MS)
		},
		dispose: cancel,
	}
}
