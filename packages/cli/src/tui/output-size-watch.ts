/** The slice of a terminal output stream this watcher touches. */
export interface WatchedOutput {
	readonly isTTY?: boolean
	/**
	 * Node's own size refresh on a terminal stream: it asks the console for its current size
	 * and emits `resize` when that differs from the last one it saw. It is not in the public
	 * typings, so its presence is checked rather than assumed.
	 */
	_refreshSize?: () => void
}

export interface SizeWatchTimers {
	setInterval(run: () => void, ms: number): unknown
	clearInterval(handle: unknown): void
}

/** How often the console is asked for its size. A person drags a pane edge, so a quarter second is imperceptible. */
export const SIZE_WATCH_INTERVAL_MS = 250

/**
 * Keep a Windows pseudo-console program told about its own width.
 *
 * Ink lays the whole screen out from `stdout.columns` and redraws only when the stream
 * emits `resize`. Node raises that event from a console-layout notification, which a
 * program run as the desktop's embedded interpreter on a pseudo-console has not been
 * seen to receive: after a split the terminal pane is narrow, the program still lays
 * out for the width it started with, and every line it writes wraps in the pane. Asking
 * the console for its size on a short timer, which makes Node raise the event itself
 * when the answer changed, removes the dependence on that notification. Everywhere else
 * the notification works, so nothing is watched.
 *
 * Returns the function that stops the watch, or `undefined` when nothing is watched.
 */
export function watchOutputSize(
	output: WatchedOutput,
	platform: NodeJS.Platform = process.platform,
	timers: SizeWatchTimers = { setInterval, clearInterval },
): (() => void) | undefined {
	if (platform !== 'win32' || output.isTTY !== true) return undefined
	if (typeof output._refreshSize !== 'function') return undefined
	const handle = timers.setInterval(() => {
		try {
			output._refreshSize?.()
		} catch {
			/* A console that cannot be asked keeps the size it already has. */
		}
	}, SIZE_WATCH_INTERVAL_MS)
	;(handle as { unref?: () => void } | undefined)?.unref?.()
	return () => timers.clearInterval(handle)
}
