/**
 * `file_changed` events for a session: the watcher and what it fires.
 *
 * The files watched are the ones named in the matchers of the `file_changed`
 * hooks the host attached, plus the list hooks have handed back with
 * `hookSpecificOutput.watchPaths`. A new list from any hook of `session_start`,
 * `file_changed` or `cwd_changed` replaces the one handed back before; the
 * matcher paths stay. With neither, no watcher exists.
 *
 * A hook of `file_changed` cannot refuse anything and gives the model nothing:
 * what it may answer is a line for the person (`systemMessage`, passed to
 * `onNotice`) and the next list of paths.
 */

import type { SessionId } from '../types/ids/index.js'
import type { PluginHookResult } from '../types/plugin/index.js'
import { FileChangeWatcher, type FileChangeWatcherOptions } from './file-change-watch.js'
import type { PluginLifecycleManager } from './lifecycle.js'

export interface FileChangeHooksOptions {
	readonly manager: Pick<PluginLifecycleManager, 'executeHooks'>
	/** Relative paths are under this folder. */
	readonly cwd: string
	/** The session now; asked at each event, because a host's session can change. */
	readonly sessionId: () => string
	/** Paths the `file_changed` matchers name, from the host's hook configuration. */
	readonly matcherPaths: readonly string[]
	/** A line a hook gave for the person. */
	readonly onNotice?: (line: string) => void
	/** A watch that failed or was cut short, once per distinct sentence. */
	readonly onProblem?: (line: string) => void
	/** Seams for tests. */
	readonly watcher?: Pick<
		FileChangeWatcherOptions,
		'settleMs' | 'maxPaths' | 'watchDirectory' | 'exists'
	>
}

/** The paths a set of answers hand back: the union, or `undefined` when no answer carried the field. */
export function watchPathsOf(results: readonly PluginHookResult[]): readonly string[] | undefined {
	let seen = false
	const paths: string[] = []
	for (const result of results) {
		if (!('watchPaths' in result) || result.watchPaths === undefined) continue
		seen = true
		for (const path of result.watchPaths) if (!paths.includes(path)) paths.push(path)
	}
	return seen ? paths : undefined
}

export class FileChangeHooks {
	private handedBack: readonly string[] = []
	private readonly watcher: FileChangeWatcher
	private closed = false

	constructor(private readonly options: FileChangeHooksOptions) {
		this.watcher = new FileChangeWatcher({
			...options.watcher,
			...(options.onProblem ? { onProblem: options.onProblem } : {}),
			onChange: (change) => {
				void this.fire(change.path, change.change)
			},
		})
		this.refresh()
	}

	/** The files watched now, absolute. */
	get watching(): readonly string[] {
		return this.watcher.watching
	}

	/** What the answers of a `session_start`, `file_changed` or `cwd_changed` run said: notices and a new list. */
	absorb(results: readonly PluginHookResult[]): void {
		if (this.closed) return
		for (const result of results) {
			const notice = 'notice' in result ? result.notice : undefined
			if (notice !== undefined && notice.trim() !== '') this.options.onNotice?.(notice.trim())
		}
		const next = watchPathsOf(results)
		if (next === undefined) return
		this.handedBack = next
		this.refresh()
	}

	close(): void {
		this.closed = true
		this.watcher.close()
	}

	private refresh(): void {
		const all = [...this.options.matcherPaths]
		for (const path of this.handedBack) if (!all.includes(path)) all.push(path)
		this.watcher.setPaths(all, this.options.cwd)
	}

	private async fire(path: string, change: 'change' | 'add' | 'unlink'): Promise<void> {
		if (this.closed) return
		// What the hook writes to this very file is not a new change: without
		// this a hook that touches the file it watches would start itself again
		// every half second for as long as the session lives.
		this.watcher.hold(path)
		try {
			const results = await this.options.manager.executeHooks('file_changed', {
				sessionId: this.options.sessionId() as SessionId,
				filePath: path,
				change,
			})
			this.absorb(results)
		} catch (error) {
			this.options.onProblem?.(
				`A file_changed hook could not run for ${path}: ${error instanceof Error ? error.message : String(error)}.`,
			)
		} finally {
			this.watcher.release(path)
		}
	}
}
