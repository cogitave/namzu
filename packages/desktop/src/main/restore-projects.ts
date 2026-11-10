/** How many projects start their runtime at the same time while the app opens. */
export const RESTORE_CONCURRENCY = 3

export interface RestoreOptions {
	paths: readonly string[]
	limit?: number
	/** True once the app is quitting: nothing new is started. */
	stopped: () => boolean
	open: (path: string) => Promise<unknown>
	/** Runs for every path that was started, whether it opened or not. */
	settle: (path: string) => void
	failed: (error: unknown) => void
}

/**
 * Opens the saved projects a few at a time. Each project is a runtime process of its own that
 * costs a cold start, so one after another makes opening take their sum; a small pool takes
 * about the time of the slowest. Paths are started in the given order, and a failure in one
 * never stops the others, even when recording it throws; the failure carries the reason
 * `desktopFailure` gives it (a missing, unreadable or not-a-folder path). Resolves when every
 * started path has settled.
 */
export async function restoreProjects(options: RestoreOptions): Promise<void> {
	const limit = Math.max(1, options.limit ?? RESTORE_CONCURRENCY)
	let next = 0
	const worker = async (): Promise<void> => {
		while (next < options.paths.length) {
			if (options.stopped()) return
			const path = options.paths[next]
			next += 1
			if (path === undefined) return
			try {
				await options.open(path)
			} catch (error) {
				try {
					options.failed(error)
				} catch {
					/* A broken diagnostic sink must not stop the restore. */
				}
			} finally {
				options.settle(path)
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, options.paths.length) }, worker))
}
