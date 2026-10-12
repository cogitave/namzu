import type { StopIdleWslcSession } from './contract.js'
import { createWslcSetupHost } from './host.js'
import { wslcBinaryOf } from './wslc-shared.js'

/** A row of `wslc system session list`: id, creator pid, display name. */
const SESSION_ROW = /^\s*\d+\s+\d+\s+(\S+)/

/**
 * Whether the default wslc session is running. `wslc system session list`
 * reads the session manager and does not start a session (unlike `list` and
 * `image`, which do). The default session is the one wslc names `wslc-cli-*`.
 */
export function defaultSessionRunning(listOutput: string): boolean {
	return listOutput
		.split(/\r?\n/)
		.some((line) => (SESSION_ROW.exec(line)?.[1] ?? '').startsWith('wslc-cli'))
}

/**
 * Stop the wslc session's virtual machine when nothing runs in it. Answers
 * `busy` and does nothing while any container runs, Namzu's or not, and
 * `not-running` when there is no session to stop.
 *
 * A container could start between the check and the terminate; the window is
 * milliseconds and the caller owns the sessions it starts. If the check itself
 * fails, the error is thrown and the session is left alone.
 */
export const stopIdleWslcSession: StopIdleWslcSession = async (options) => {
	const host = createWslcSetupHost(options.host)
	const binary = wslcBinaryOf(host)
	const { signal } = options
	const sessions = await host.runner.run(binary, ['system', 'session', 'list'], { signal })
	if (!defaultSessionRunning(sessions)) return { outcome: 'not-running' }
	// Running containers only: `list` without `--all`.
	const running = await host.runner.run(binary, ['list', '-q'], { signal })
	if (running.trim() !== '') return { outcome: 'busy' }
	await host.runner.run(binary, ['system', 'session', 'terminate'], { signal })
	return { outcome: 'stopped' }
}
