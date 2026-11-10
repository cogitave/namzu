/**
 * Read and write the settings Desktop shows, against the user config file.
 *
 * Every write is checked twice before it touches the file: the value must suit
 * its control, and the loader's own reader for that key must accept the whole
 * block it would produce. A secret-bearing or command-running setting (a
 * `file-only` control) is never read out or written here.
 */

import { existsSync, readFileSync } from 'node:fs'
import { parse as yamlParse } from 'yaml'

import { ConfigValueError, readConfigKey } from './load.js'
import {
	SETTING_DESCRIPTORS,
	type SettingDescriptor,
	type SettingSection,
} from './settings-descriptors.js'
import {
	type UserConfigWriteOptions,
	deleteUserConfigValue,
	setUserConfigValue,
	userConfigPath,
} from './user-config.js'

export interface SettingState {
	readonly path: string
	/** Written in the user file. Absent means the default (or a project file) applies. */
	readonly set: boolean
	/** The value, as JSON text for a list or table. Never present for a `file-only` setting. */
	readonly value?: unknown
}

export interface SettingsSnapshot {
	readonly file: string
	readonly settings: readonly SettingState[]
	readonly descriptors: readonly SettingDescriptor[]
}

function descriptorFor(path: string): SettingDescriptor {
	const found = SETTING_DESCRIPTORS.find((entry) => entry.path === path)
	if (!found) throw new Error('That is not a setting Namzu can change here.')
	return found
}

function readUserDocument(opts: UserConfigWriteOptions): Record<string, unknown> {
	const file = userConfigPath(opts)
	if (!existsSync(file)) return {}
	const parsed: unknown = yamlParse(readFileSync(file, 'utf8'))
	if (parsed === null || parsed === undefined) return {}
	if (typeof parsed !== 'object' || Array.isArray(parsed))
		throw new Error(`${file} is not a mapping of settings; fix it first`)
	return parsed as Record<string, unknown>
}

function lookup(doc: Record<string, unknown>, path: readonly string[]): unknown {
	let at: unknown = doc
	for (const segment of path) {
		if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined
		at = (at as Record<string, unknown>)[segment]
	}
	return at
}

export function readSettings(opts: UserConfigWriteOptions = {}): SettingsSnapshot {
	const doc = readUserDocument(opts)
	const settings = SETTING_DESCRIPTORS.map((entry): SettingState => {
		const value = lookup(doc, entry.path.split('.'))
		if (value === undefined) return { path: entry.path, set: false }
		if (entry.control.kind === 'file-only') return { path: entry.path, set: true }
		return { path: entry.path, set: true, value }
	})
	return { file: userConfigPath(opts), settings, descriptors: SETTING_DESCRIPTORS }
}

function coerce(entry: SettingDescriptor, raw: unknown): unknown {
	const control = entry.control
	switch (control.kind) {
		case 'toggle':
			if (typeof raw !== 'boolean') throw new Error('Choose on or off.')
			return raw
		case 'select':
			if (typeof raw !== 'string' || !control.options.some((o) => o.value === raw))
				throw new Error(`Choose one of: ${control.options.map((o) => o.value).join(', ')}.`)
			return raw
		case 'checks': {
			if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string'))
				throw new Error('Choose from the list.')
			const allowed = control.options.map((o) => o.value)
			if (raw.some((v) => !allowed.includes(v as string)))
				throw new Error(`Choose from: ${allowed.join(', ')}.`)
			return raw
		}
		case 'number':
			if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('Enter a number.')
			if (control.min !== undefined && raw < control.min)
				throw new Error(`Enter ${control.min} or more.`)
			if (control.max !== undefined && raw > control.max)
				throw new Error(`Enter ${control.max} or less.`)
			return raw
		case 'text': {
			if (typeof raw !== 'string') throw new Error('Enter some text.')
			const text = raw.trim()
			if (text.length === 0 || text.length > 2000)
				throw new Error('Enter between 1 and 2000 characters.')
			return text
		}
		case 'json': {
			if (typeof raw !== 'string') throw new Error('Enter JSON.')
			if (raw.length > 100_000) throw new Error('That is too long.')
			try {
				return JSON.parse(raw) as unknown
			} catch (error) {
				throw new Error(`That is not valid JSON: ${(error as Error).message}`)
			}
		}
		case 'file-only':
			throw new Error('Edit this one in the config file; Desktop does not show or change it.')
	}
}

/** Validate against the loader as it would read the file after the change. */
function checkWhole(
	doc: Record<string, unknown>,
	path: readonly string[],
	value: unknown | undefined,
	file: string,
): void {
	const [root, ...rest] = path as [string, ...string[]]
	let block: unknown
	if (rest.length === 0) block = value
	else {
		const current = doc[root]
		const base =
			current && typeof current === 'object' && !Array.isArray(current)
				? structuredClone(current as Record<string, unknown>)
				: {}
		let at = base as Record<string, unknown>
		for (const segment of rest.slice(0, -1)) {
			const next = at[segment]
			if (!next || typeof next !== 'object' || Array.isArray(next)) at[segment] = {}
			at = at[segment] as Record<string, unknown>
		}
		const last = rest[rest.length - 1] as string
		if (value === undefined) delete at[last]
		else at[last] = value
		block = base
	}
	if (block === undefined) return
	try {
		readConfigKey(root, block, file)
	} catch (error) {
		if (error instanceof ConfigValueError) throw new Error(error.message)
		throw error
	}
}

export interface SettingChange {
	readonly path: string
	/** Absent clears the setting so the default applies again. */
	readonly value?: unknown
}

export function describeChange(path: string): { confirm?: string; section: SettingSection } {
	const entry = descriptorFor(path)
	return { section: entry.section, ...(entry.confirm ? { confirm: entry.confirm } : {}) }
}

export function writeSetting(change: SettingChange, opts: UserConfigWriteOptions = {}): void {
	const entry = descriptorFor(change.path)
	const path = entry.path.split('.')
	const file = userConfigPath(opts)
	if (change.value === undefined || change.value === null) {
		if (entry.control.kind === 'file-only') throw new Error('Edit this one in the config file.')
		checkWhole(readUserDocument(opts), path, undefined, file)
		deleteUserConfigValue(path, opts)
		return
	}
	const value = coerce(entry, change.value)
	checkWhole(readUserDocument(opts), path, value, file)
	setUserConfigValue(path, value, opts)
}
