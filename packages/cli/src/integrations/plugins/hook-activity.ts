/**
 * What hooks do beside answering: variables for later commands, files to
 * watch, and a line for the person.
 *
 * One of these belongs to one agent session. It owns the variables file of the
 * session ({@link SessionHookEnv}, handed to every shell hook so a
 * `session_start`, `cwd_changed` or `file_changed` hook is told where to
 * append `export NAME=value`), the watcher behind `file_changed`
 * ({@link FileChangeHooks}) and the lines hooks gave for the person. Nothing
 * is made, watched or written until a hook asks.
 */
import {
	FileChangeHooks,
	type HookEnvEvent,
	type PluginHookResult,
	type PluginLifecycleManager,
	SessionHookEnv,
	fileChangedMatcherNote,
	fileChangedMatcherPaths,
} from '@namzu/sdk'

import type { HooksConfig } from '../../config/schema.js'
import { cliLogger } from '../../logging.js'

/** What `/hooks` shows of the above. */
export interface HookActivity {
	/** The variables hooks have set, by name, with the kind of hook that set each; never the values. */
	readonly variables: readonly { readonly name: string; readonly event: HookEnvEvent }[]
	/** The files watched now, absolute. */
	readonly watching: readonly string[]
	/** `file_changed` hooks whose matcher names no file, in a sentence each. */
	readonly notes: readonly string[]
}

export interface SessionHookActivity {
	/** The variables hooks have set, live. The shell tool's environment for this session. */
	readonly variables: Record<string, string>
	/** The shell hook options that carry the variables file. */
	readonly hookEnv: SessionHookEnv
	/** A `session_start` run's answers: the first list of files to watch, and notices. */
	absorbSessionStart(results: readonly PluginHookResult[]): void
	/**
	 * The folder commands run in changed: forget what the folder's hooks set,
	 * run the `cwd_changed` hooks (awaited, so the next command sees what they
	 * set) and take their answers.
	 */
	changeDirectory(change: { readonly from: string; readonly to: string }): Promise<void>
	describe(): HookActivity
	/** Lines hooks gave for the person (`systemMessage`, a watch that failed, a variable not read). */
	onNotice(listener: (line: string) => void): () => void
	close(): void
}

/** The most notices held for a listener that has not arrived yet. */
const MAX_PENDING_NOTICES = 20

export function createSessionHookActivity(options: {
	readonly manager: PluginLifecycleManager
	readonly hooks: HooksConfig | undefined
	readonly cwd: string
	readonly sessionId: () => string
}): SessionHookActivity {
	const listeners = new Set<(line: string) => void>()
	const pending: string[] = []
	const notify = (line: string): void => {
		cliLogger().warn('hook', { 'namzu.hook.notice': line })
		if (listeners.size === 0) {
			if (pending.length < MAX_PENDING_NOTICES) pending.push(line)
			return
		}
		for (const listener of listeners) listener(line)
	}
	const hookEnv = new SessionHookEnv({ onProblem: notify })
	const entries = options.hooks?.file_changed ?? []
	const matcherPaths = entries.flatMap((entry) => fileChangedMatcherPaths(entry.matcher))
	const files = new FileChangeHooks({
		manager: options.manager,
		cwd: options.cwd,
		sessionId: options.sessionId,
		matcherPaths,
		onNotice: notify,
		onProblem: notify,
	})
	return {
		variables: hookEnv.variables,
		hookEnv,
		absorbSessionStart: (results) => files.absorb(results),
		async changeDirectory(change) {
			hookEnv.clearFolderLayers()
			try {
				const results = await options.manager.executeHooks('cwd_changed', {
					sessionId: options.sessionId() as never,
					oldCwd: change.from,
					newCwd: change.to,
				})
				files.absorb(results)
			} catch (error) {
				notify(
					`A cwd_changed hook could not run: ${error instanceof Error ? error.message : String(error)}.`,
				)
			}
		},
		describe: () => ({
			variables: hookEnv.describe(),
			watching: files.watching,
			notes: entries
				.map((entry) => fileChangedMatcherNote(entry.matcher))
				.filter((note): note is string => note !== undefined),
		}),
		onNotice(listener) {
			listeners.add(listener)
			for (const line of pending.splice(0)) listener(line)
			return () => {
				listeners.delete(listener)
			}
		},
		close() {
			files.close()
			hookEnv.dispose()
			listeners.clear()
		},
	}
}
