import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { namzuHomePath } from './integrations/state/home.js'
import { homePath } from './tui/person-terms.js'
import { debugRequested } from './tui/plain-interruption.js'
import { CLI_VERSION } from './version.js'

/** Crash logs kept in the log folder; older ones are removed when a new one is written. */
const KEEP_CRASH_LOGS = 10

export interface CrashReportOptions {
	/** Extra text for the log only, such as buffered diagnostics. */
	readonly extra?: string
	readonly env?: Record<string, string | undefined>
	readonly argv?: readonly string[]
	readonly now?: Date
	/** The folder crash logs go in. Default: `logs/` under the Namzu home. */
	readonly dir?: string
}

function technical(err: unknown): string {
	return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

/**
 * Save the technical record of a crash and return the log's path, or
 * `undefined` when it could not be written. The stack belongs in this file,
 * not on the person's screen.
 */
export function writeCrashLog(err: unknown, options: CrashReportOptions = {}): string | undefined {
	try {
		const dir = options.dir ?? join(namzuHomePath(), 'logs')
		mkdirSync(dir, { recursive: true })
		const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
		const path = join(dir, `crash-${stamp}.log`)
		const header = [
			`Namzu ${CLI_VERSION}`,
			`Platform: ${process.platform} ${process.arch}, Node ${process.version}`,
			`Time: ${(options.now ?? new Date()).toISOString()}`,
			'',
		]
		writeFileSync(
			path,
			`${header.join('\n')}${technical(err)}\n${options.extra ? `\n${options.extra}\n` : ''}`,
			{ mode: 0o600 },
		)
		try {
			const old = readdirSync(dir)
				.filter((name) => /^crash-.*\.log$/.test(name))
				.sort()
				.slice(0, -KEEP_CRASH_LOGS)
			for (const name of old) rmSync(join(dir, name), { force: true })
		} catch {
			// Pruning is housekeeping; the new log is already saved.
		}
		return path
	} catch {
		return undefined
	}
}

/**
 * What the terminal prints when the app dies of an unexpected error: one plain
 * line naming the saved log, and the stack only on request (`NAMZU_DEBUG=1` or
 * `--debug`). Writes the log as a side effect. Ends with a newline.
 */
export function reportCrash(err: unknown, options: CrashReportOptions = {}): string {
	const path = writeCrashLog(err, options)
	const debug = debugRequested(options.env, options.argv)
	const line = path
		? `Namzu stopped because of an unexpected problem. Details were saved to ${homePath(path)}.`
		: 'Namzu stopped because of an unexpected problem. Run again with --debug to see details.'
	return `${line}\n${debug ? `\n${technical(err)}\n${options.extra ? `\n${options.extra}\n` : ''}` : ''}`
}
