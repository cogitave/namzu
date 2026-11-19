/**
 * Versioned steps for the state file, and the one-time import of what the renderer used to keep
 * in `localStorage`.
 *
 * A file written by a newer Namzu than this one is left alone (the store runs read-only on it),
 * so going back a version never clobbers what the newer one saved.
 */

import { defineOf } from './registry.js'

export const STATE_FILE_VERSION = 1

export interface StateEntry {
	/** The value, as the string a `Storage` holds. */
	v: string
	/** When it was written, in milliseconds. */
	t: number
}

export interface StateFile {
	version: number
	/** False from the moment the app starts until a quit has flushed everything. */
	cleanShutdown: boolean
	savedAt: number
	/** Set once the renderer's old `localStorage` keys have been copied in. */
	legacyImported: boolean
	entries: Record<string, StateEntry>
}

export const emptyStateFile = (now: number): StateFile => ({
	version: STATE_FILE_VERSION,
	cleanShutdown: true,
	savedAt: now,
	legacyImported: false,
	entries: {},
})

/** One step per version: `STEPS[n]` turns a version-`n` file into a version-`n+1` file. */
const STEPS: Record<number, (file: Record<string, unknown>) => Record<string, unknown>> = {}

export type ParsedStateFile =
	| { kind: 'ok'; file: StateFile }
	| { kind: 'newer' }
	| { kind: 'unreadable' }

/**
 * Reads a state file's text. Each entry is checked on its own: an unknown key, a non-string value,
 * or a value over its key's cap is dropped without failing the rest.
 */
export function parseStateFile(text: string, now: number): ParsedStateFile {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		return { kind: 'unreadable' }
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'unreadable' }
	let record = raw as Record<string, unknown>
	let version = record.version
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
		return { kind: 'unreadable' }
	if (version > STATE_FILE_VERSION) return { kind: 'newer' }
	while (version < STATE_FILE_VERSION) {
		const step = STEPS[version]
		if (!step) return { kind: 'unreadable' }
		record = step(record)
		version += 1
	}
	const entries: Record<string, StateEntry> = {}
	const stored = record.entries
	if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
		for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
			const def = defineOf(key)
			if (!def || !value || typeof value !== 'object') continue
			const { v, t } = value as Record<string, unknown>
			if (typeof v !== 'string' || Buffer.byteLength(v) > def.maxBytes) continue
			entries[key] = { v, t: typeof t === 'number' && Number.isFinite(t) ? t : now }
		}
	}
	return {
		kind: 'ok',
		file: {
			version: STATE_FILE_VERSION,
			cleanShutdown: record.cleanShutdown === true,
			savedAt: typeof record.savedAt === 'number' ? record.savedAt : now,
			legacyImported: record.legacyImported === true,
			entries,
		},
	}
}

/** What the renderer may hand over from its old `localStorage`: only keys the registry declares. */
export function legacyEntries(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const def = defineOf(key)
		if (!def || typeof value !== 'string' || Buffer.byteLength(value) > def.maxBytes) continue
		// A key the main process alone writes is never taken from the page.
		if (def.id === 'window.mode') continue
		out[key] = value
	}
	return out
}
