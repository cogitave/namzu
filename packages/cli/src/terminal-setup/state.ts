import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { namzuHomePath } from '../integrations/state/home.js'

/**
 * What Namzu remembers about this person's terminal between launches, kept in
 * `~/.namzu/terminal-state.json` beside the other per-person records:
 *
 * - whether `/terminal setup` has put in the newline key (so the hint that
 *   suggests it stops), and
 * - the record that tells a fullscreen start that never finished from one that
 *   did (see `tui/fullscreen/boot-canary.ts`).
 *
 * An unreadable file reads as empty, so a damaged record costs one more hint
 * and never blocks a start. A write that fails is dropped: remembering a
 * terminal is not worth stopping the composer for.
 */

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** A launch that asked for fullscreen and has not yet been seen to be healthy. */
export interface BootPending {
	readonly startedAt: number
	readonly version: string
	readonly host: string
	readonly platform: string
	/** Set when the interface itself failed while starting. */
	readonly died?: 'render_error'
}

export interface TerminalState {
	/** `/terminal setup` wrote the newline key for this terminal. */
	readonly shiftEnterInstalled?: boolean
	/** `/terminal setup` turned on "Use Option as Meta key" in Terminal.app. */
	readonly optionAsMetaInstalled?: boolean
	/** Launches that asked for fullscreen, by process id. */
	readonly fullscreenBootPending?: Readonly<Record<string, BootPending>>
	/** Failed starts counted so far for one version. */
	readonly fullscreenBootStrikes?: { readonly count: number; readonly version: string }
	/** Fullscreen is turned off here for this version after repeated failed starts. */
	readonly fullscreenAutoDisabled?: {
		readonly version: string
		readonly at: number
		readonly strikes: number
	}
}

export function terminalStatePath(home?: string): string {
	return join(namzuHomePath(home), 'terminal-state.json')
}

export function readTerminalState(home?: string): TerminalState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(terminalStatePath(home), 'utf8'))
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
		return parsed as TerminalState
	} catch {
		return {}
	}
}

const LOCK_STALE_MS = 5_000
const LOCK_TRIES = 100

function pause(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
	} catch {
		// no way to wait here: the next try follows at once
	}
}

/**
 * Hold a short lock file while the state is read, changed and written, so two
 * launches at the same moment do not overwrite each other's records. A lock
 * left by a crashed launch is taken over after 5 seconds; if the lock cannot
 * be had at all the update goes ahead without it.
 */
function withLock<T>(path: string, run: () => T): T {
	const lock = `${path}.lock`
	let held = false
	try {
		mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
		for (let i = 0; i < LOCK_TRIES && !held; i++) {
			try {
				writeFileSync(lock, String(process.pid), { flag: 'wx', mode: FILE_MODE })
				held = true
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break
				try {
					if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true })
				} catch {
					// it went away between the two calls
				}
				pause(5)
			}
		}
	} catch {
		// an unreachable folder fails the write below as well
	}
	try {
		return run()
	} finally {
		if (held) {
			try {
				rmSync(lock, { force: true })
			} catch {
				// a stale lock is taken over later
			}
		}
	}
}

/** Read, change and write the state. Returns what was written (or would have been). */
export function updateTerminalState(
	change: (state: TerminalState) => TerminalState,
	home?: string,
): TerminalState {
	const path = terminalStatePath(home)
	return withLock(path, () => writeState(path, change, home))
}

function writeState(
	path: string,
	change: (state: TerminalState) => TerminalState,
	home?: string,
): TerminalState {
	const next = change(readTerminalState(home))
	const temp = `${path}.${randomUUID()}.tmp`
	try {
		mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE })
		renameSync(temp, path)
	} catch {
		try {
			rmSync(temp, { force: true })
		} catch {
			// nothing reachable to clean up
		}
	}
	return next
}
