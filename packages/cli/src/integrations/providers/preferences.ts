/**
 * `~/.namzu/preferences.json` — the user's primary-chat picker selection.
 *
 * Schema (current = v2):
 *   {
 *     "version": 2,
 *     "provider": "anthropic",            // ProviderId
 *     "model": "claude-opus-4-7",         // optional model override
 *     "subagents": { "active": [...] }    // clawtool peer instances reserved for subagent dispatch
 *   }
 *
 * The previous schema (v1) stored a clawtool peer instance as the
 * default — a different primitive (subagent dispatch, not primary
 * chat). On-disk v1 files trigger a forced re-pick rather than an
 * auto-migration: mapping between the two semantics would surprise
 * more than help.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ProviderId } from './registry.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
export const PREFERENCES_FILE_VERSION = 2 as const

export interface Preferences {
	readonly version: 2
	readonly provider: ProviderId
	readonly model?: string
	readonly subagents?: { readonly active: readonly string[] }
}

export type ReadResult =
	| { readonly status: 'ok'; readonly prefs: Preferences }
	| { readonly status: 'missing' }
	| { readonly status: 'needs-repick'; readonly reason: string }

export class PreferencesError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PreferencesError'
	}
}

export function preferencesPath(home: string = homedir()): string {
	return join(home, '.namzu', 'preferences.json')
}

export function readPreferences(home: string = homedir()): ReadResult {
	const path = preferencesPath(home)
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
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
	if (typeof parsed !== 'object' || parsed === null) {
		throw new PreferencesError(`${path} top-level must be an object`)
	}
	const v = parsed as { version?: unknown }
	if (v.version === 1) {
		return {
			status: 'needs-repick',
			reason:
				'preferences file uses an older schema (v1) — namzu now picks an LLM provider client directly. Please re-pick.',
		}
	}
	if (v.version !== PREFERENCES_FILE_VERSION) {
		return {
			status: 'needs-repick',
			reason: `preferences file at unsupported version ${String(v.version)} — please re-pick.`,
		}
	}
	if (!isPreferences(parsed)) {
		throw new PreferencesError(`${path} has an unexpected shape`)
	}
	return { status: 'ok', prefs: parsed }
}

export function writePreferences(prefs: Preferences, home: string = homedir()): void {
	if (prefs.version !== PREFERENCES_FILE_VERSION) {
		throw new PreferencesError(
			`unsupported preferences version: ${String(prefs.version)} (expected ${PREFERENCES_FILE_VERSION})`,
		)
	}
	if (typeof prefs.provider !== 'string' || prefs.provider.length === 0) {
		throw new PreferencesError('preferences.provider is required')
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
	if (typeof v.provider !== 'string' || v.provider.length === 0) return false
	if (v.model !== undefined && typeof v.model !== 'string') return false
	if (v.subagents !== undefined) {
		if (typeof v.subagents !== 'object' || v.subagents === null) return false
		const sa = v.subagents as Record<string, unknown>
		if (!Array.isArray(sa.active)) return false
		for (const item of sa.active) {
			if (typeof item !== 'string') return false
		}
	}
	return true
}
