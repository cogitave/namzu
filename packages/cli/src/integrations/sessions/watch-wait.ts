/**
 * Waiting for a session's files to change, without spinning.
 *
 * The file system tells us when the log or the lease changes (`fs.watch` on
 * the project folder and the session folder). A notification is a hint, not a
 * fact: some file systems drop them, and a lease lapsing changes no file at
 * all. So every wait is also bounded by a timer, and the caller reads the
 * files again whichever came first.
 */

import { type FSWatcher, watch } from 'node:fs'

export const DEFAULT_FALLBACK_MS = 1_000

export interface WaitTarget {
	/** A folder to watch. */
	readonly dir: string
	/** Only events for this entry name count; absent, any entry in the folder. */
	readonly name?: string
}

export interface ChangeWaiterOptions {
	readonly targets: readonly WaitTarget[]
	/** Longest a wait lasts when no notification comes. */
	readonly fallbackMs?: number
	/** Seam for tests. */
	readonly watchDir?: (
		dir: string,
		listener: (event: string, name: string | null) => void,
	) => FSWatcher
}

export class ChangeWaiter {
	readonly #fallbackMs: number
	readonly #watchers: FSWatcher[] = []
	#dirty = false
	#wake: (() => void) | undefined

	constructor(options: ChangeWaiterOptions) {
		this.#fallbackMs = options.fallbackMs ?? DEFAULT_FALLBACK_MS
		const open =
			options.watchDir ??
			((dir, listener) => watch(dir, { persistent: false }, (event, name) => listener(event, name)))
		for (const target of options.targets) {
			try {
				const watcher = open(target.dir, (_event, name) => {
					if (target.name !== undefined && name !== null && String(name) !== target.name) return
					this.#dirty = true
					this.#wake?.()
				})
				// A watcher that fails later (the folder was removed) just stops
				// helping; the timer still bounds every wait.
				watcher.on('error', () => undefined)
				this.#watchers.push(watcher)
			} catch {
				// The folder does not exist yet, or the platform cannot watch it.
			}
		}
	}

	/** Resolves on the next change, on the fallback timer, or when `signal` aborts. */
	wait(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve()
		if (this.#dirty) {
			this.#dirty = false
			return Promise.resolve()
		}
		return new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(timer)
				signal.removeEventListener('abort', done)
				this.#wake = undefined
				this.#dirty = false
				resolve()
			}
			const timer = setTimeout(done, this.#fallbackMs)
			signal.addEventListener('abort', done, { once: true })
			this.#wake = done
		})
	}

	close(): void {
		for (const watcher of this.#watchers) {
			try {
				watcher.close()
			} catch {
				// Already closed.
			}
		}
		this.#watchers.length = 0
	}
}
