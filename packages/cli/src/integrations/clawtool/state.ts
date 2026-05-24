import { readFileSync } from 'node:fs'

import { daemonStatePath } from './paths.js'
import type { DaemonState } from './types.js'

/**
 * Read clawtool's daemon state file. Returns `null` if the file is missing
 * (daemon not yet started) or unparseable (corrupt state — caller decides
 * whether to overwrite via auto-spawn).
 *
 * Path defaults to `${XDG_CONFIG_HOME:-~/.config}/clawtool/daemon.json`;
 * override `path` for tests.
 */
export function readDaemonState(path?: string): DaemonState | null {
	const target = path ?? daemonStatePath()
	let raw: string
	try {
		raw = readFileSync(target, 'utf8')
	} catch {
		return null
	}
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!isValidState(parsed)) return null
		return parsed
	} catch {
		return null
	}
}

function isValidState(value: unknown): value is DaemonState {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	return (
		typeof v.version === 'number' &&
		typeof v.pid === 'number' &&
		typeof v.port === 'number' &&
		typeof v.started_at === 'string' &&
		typeof v.token_file === 'string' &&
		typeof v.log_file === 'string'
	)
}
