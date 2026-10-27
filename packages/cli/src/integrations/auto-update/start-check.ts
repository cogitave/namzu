/**
 * What a new copy must be able to load before it replaces the old one: the parts a
 * terminal session needs when it starts (the terminal interface, the runtime under
 * it, and the terminal-session module where one is installed). Nothing is started
 * and nothing is read or written: a missing or unloadable file shows up here, and
 * the update is rolled back, instead of surprising the next person who opens
 * Namzu. `namzu --start-check` runs it.
 */

import { createRequire } from 'node:module'

export const START_CHECK_FLAG = '--start-check'

export interface StartCheckDeps {
	/** Load the terminal interface and the runtime it runs on. */
	readonly loadSession: () => Promise<void>
	/** Whether the optional terminal-session module is installed next to this copy. */
	readonly ptyInstalled: () => boolean
	/** Load the terminal-session module; rejects when its native part cannot be loaded. */
	readonly loadPty: () => Promise<void>
	readonly write: (text: string) => void
}

const productionDeps: StartCheckDeps = {
	loadSession: async () => {
		await import('../../tui/index.js')
		await import('../../cli-runtime.js')
	},
	ptyInstalled: () => {
		try {
			createRequire(import.meta.url).resolve('node-pty')
			return true
		} catch {
			return false
		}
	},
	loadPty: async () => {
		const loaded = (await import('node-pty')) as { spawn?: unknown; default?: { spawn?: unknown } }
		if (typeof (loaded.spawn ?? loaded.default?.spawn) !== 'function') {
			throw new Error('the terminal-session module has no spawn function')
		}
	},
	write: (text) => void process.stdout.write(text),
}

/** Exit code: 0 when everything a session needs loads (and `ok` is printed), 1 otherwise. */
export async function runStartCheck(deps: StartCheckDeps = productionDeps): Promise<number> {
	try {
		await deps.loadSession()
	} catch (error) {
		deps.write(`start check failed: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
	if (deps.ptyInstalled()) {
		try {
			await deps.loadPty()
		} catch (error) {
			deps.write(
				`start check failed: the terminal-session module did not load (${error instanceof Error ? error.message : String(error)})\n`,
			)
			return 1
		}
	}
	deps.write('ok\n')
	return 0
}
