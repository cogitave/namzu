/**
 * Reopen the saved projects one after another.
 *
 * One folder that cannot be opened ends that folder's turn and nothing else:
 * the failure is recorded with a reason (`desktopFailure` names a missing,
 * unreadable or not-a-folder path) and the loop goes on to the next. Every
 * path is settled, opened or not, so no project stays "connecting".
 */
export async function restoreProjects(
	paths: readonly string[],
	hooks: {
		open(path: string): Promise<unknown>
		settle(path: string): void
		failed(error: unknown): void
		/** True once the application is quitting; the loop stops at the next path. */
		quitting(): boolean
	},
): Promise<{ opened: number; failed: number }> {
	let opened = 0
	let failed = 0
	for (const path of paths) {
		if (hooks.quitting()) break
		try {
			await hooks.open(path)
			opened += 1
		} catch (error) {
			failed += 1
			try {
				hooks.failed(error)
			} catch {
				/* A broken diagnostic sink must not stop the restore. */
			}
		} finally {
			hooks.settle(path)
		}
	}
	return { opened, failed }
}
