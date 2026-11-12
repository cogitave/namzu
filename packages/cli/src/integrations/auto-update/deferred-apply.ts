/**
 * The hand-over from a running session to the process that installs a newer version.
 *
 * A session never replaces the folder it runs from (see `running.ts`). When its updater finds that a
 * version may be installed it only calls {@link noteUpdatePending}; when the process ends, whichever way,
 * this starts `namzu --apply-at-exit` detached. That process waits until no Namzu process runs from the
 * install any more and then installs (`apply-at-exit.ts`). Kept free of heavy imports: the binary
 * loads it statically.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The internal flag the detached installer is started with. */
export const APPLY_AT_EXIT_FLAG = '--apply-at-exit'

let pendingChannel: string | undefined
let armed = false

/** The update loop found a version to install; start the installer when this process ends. */
export function noteUpdatePending(channel: string): void {
	pendingChannel = channel
	if (armed) return
	armed = true
	process.once('exit', () => launchApplyAtExit())
}

/** Whether this process will start the installer when it ends (tests). */
export function updatePendingAtExit(): boolean {
	return armed
}

/** Start the detached installer now. Never throws: a missed start is retried by the next session's exit. */
export function launchApplyAtExit(
	spawnProcess: typeof spawn = spawn,
	entry: string = fileURLToPath(new URL('../../bin.js', import.meta.url)),
): boolean {
	try {
		const child = spawnProcess(process.execPath, [entry, APPLY_AT_EXIT_FLAG], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
			env: {
				...process.env,
				NAMZU_AUTO_UPDATE: '1',
				NAMZU_UPDATE_CHECK: '1',
				...(pendingChannel ? { NAMZU_UPDATE_CHANNEL: pendingChannel } : {}),
			},
		})
		child.on('error', () => undefined)
		child.unref()
		return true
	} catch {
		return false
	}
}
