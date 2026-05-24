/**
 * `~/.namzu/preferences.json` — user's selection over clawtool's agent
 * registry. **Stores instance names only, never credentials**; credentials
 * live in clawtool's domain.
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "default": "claude",
 *     "active": ["claude", "codex", "gemini"]
 *   }
 *
 * `default` = which instance handles the user's direct turn.
 * `active` = which instances are available for subagent dispatch (must
 * include `default`).
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
export const PREFERENCES_FILE_VERSION = 1 as const

export interface Preferences {
	readonly version: 1
	readonly default: string
	readonly active: readonly string[]
}

export class PreferencesError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PreferencesError'
	}
}

export function preferencesPath(home: string = homedir()): string {
	return join(home, '.namzu', 'preferences.json')
}

/** Returns null when the file is missing (first-run signal). */
export function readPreferences(home: string = homedir()): Preferences | null {
	const path = preferencesPath(home)
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw new PreferencesError(
			`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new PreferencesError(
			`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	if (!isPreferences(parsed)) {
		throw new PreferencesError(`${path} has an unexpected shape`)
	}
	return parsed
}

export function writePreferences(prefs: Preferences, home: string = homedir()): void {
	if (prefs.version !== PREFERENCES_FILE_VERSION) {
		throw new PreferencesError(
			`unsupported preferences version: ${String(prefs.version)} (expected ${PREFERENCES_FILE_VERSION})`,
		)
	}
	if (prefs.default.length === 0) {
		throw new PreferencesError('preferences.default is required')
	}
	if (!prefs.active.includes(prefs.default)) {
		throw new PreferencesError(
			`preferences.active must include the default instance "${prefs.default}"`,
		)
	}
	const path = preferencesPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	const body = `${JSON.stringify(prefs, null, 2)}\n`
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
	writeFileSync(tmp, body, { mode: FILE_MODE })
	chmodSync(tmp, FILE_MODE)
	renameSync(tmp, path)
}

function isPreferences(value: unknown): value is Preferences {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	if (v.version !== PREFERENCES_FILE_VERSION) return false
	if (typeof v.default !== 'string' || v.default.length === 0) return false
	if (!Array.isArray(v.active)) return false
	for (const item of v.active) {
		if (typeof item !== 'string' || item.length === 0) return false
	}
	return (v.active as string[]).includes(v.default)
}
