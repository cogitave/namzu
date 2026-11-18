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

import { BROWSER_PROFILE_NAME, ConfigValueError, readConfigKey } from './load.js'
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
	/**
	 * The file the value in force came from. Not filled yet: the read-side layer lane sets it, and
	 * Desktop already reads the field.
	 */
	readonly layer?: 'user' | 'project' | 'local' | 'profile' | 'managed'
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
	let parsed: unknown
	try {
		parsed = yamlParse(readFileSync(file, 'utf8'))
	} catch (cause) {
		// Say which file and where, in one sentence; Desktop adds what to do, the terminal its own.
		const at = (cause as { linePos?: ReadonlyArray<{ line: number; col: number }> } | null)
			?.linePos?.[0]
		const where = at === undefined ? '' : ` (line ${at.line}, column ${at.col})`
		throw new Error(`${file} isn't valid YAML${where}.`)
	}
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

/**
 * A Desktop older than the typed default reads only `defaultText`. Fill it from the typed value so
 * that an app built before `default` existed still shows a default, in the words of the option.
 */
export function withDefaultText(entry: SettingDescriptor): SettingDescriptor {
	if (entry.defaultText !== undefined || entry.default === undefined) return entry
	const control = entry.control
	const value = entry.default
	let text: string
	if (typeof value === 'boolean') text = value ? 'on' : 'off'
	else if (Array.isArray(value)) {
		const options = control.kind === 'checks' ? control.options : []
		text =
			value.length === 0
				? 'none'
				: value
						.map((item) => options.find((option) => option.value === item)?.label ?? item)
						.join(', ')
	} else if (control.kind === 'select')
		text = control.options.find((option) => option.value === value)?.label ?? String(value)
	else text = String(value)
	return { ...entry, defaultText: entry.defaultNote ? `${text}. ${entry.defaultNote}` : text }
}

export function readSettings(opts: UserConfigWriteOptions = {}): SettingsSnapshot {
	const doc = readUserDocument(opts)
	const settings = SETTING_DESCRIPTORS.map((entry): SettingState => {
		const value = lookup(doc, entry.path.split('.'))
		if (value === undefined) return { path: entry.path, set: false }
		if (entry.control.kind === 'file-only') return { path: entry.path, set: true }
		return { path: entry.path, set: true, value }
	})
	return {
		file: userConfigPath(opts),
		settings,
		descriptors: SETTING_DESCRIPTORS.map(withDefaultText),
	}
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

/**
 * Checks the loader makes across keys, which a per-key reader cannot see. Today there is one:
 * `model: auto` needs `routing.default` to fall back to, and the loader refuses the whole file
 * without it. Desktop must never write a file the terminal app then refuses to load, whether the
 * change sets the model or removes the routing it depends on.
 */
export function checkAcrossKeys(
	doc: Record<string, unknown>,
	path: readonly string[],
	value: unknown | undefined,
): void {
	const root = path[0]
	if (root !== 'model' && root !== 'routing') return
	const after: Record<string, unknown> = { ...doc }
	if (path.length === 1) {
		if (value === undefined) delete after[root]
		else after[root] = value
	}
	if (after.model !== 'auto') return
	const routing = after.routing
	const hasDefault =
		routing !== null &&
		typeof routing === 'object' &&
		!Array.isArray(routing) &&
		(routing as Record<string, unknown>).default !== undefined
	if (hasDefault) return
	throw new Error(
		root === 'model'
			? 'Choose Automatic only after the routing setting below has a default model. Without one, Namzu cannot start.'
			: 'The model is set to Automatic, which needs a default model in routing. Choose another model first, or keep a default here.',
	)
}

/** Checks on one value that its control alone does not make. Each says its rule in plain words. */
const VALUE_CHECKS: Readonly<Record<string, (value: unknown) => void>> = {
	'browser.defaultProfile': (value) => {
		const name = String(value)
		if (name.length > 64 || !BROWSER_PROFILE_NAME.test(name))
			throw new Error(
				'Use lowercase letters and digits, with single dashes between them, up to 64 characters.',
			)
	},
	'telemetry.otlp.endpoint': (value) => {
		let url: URL
		try {
			url = new URL(String(value))
		} catch {
			throw new Error('Enter a full web address that starts with http or https.')
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:')
			throw new Error('The address must start with http or https.')
		if (url.username !== '' || url.password !== '')
			throw new Error('Do not put a user name or password in the address.')
	},
}

/**
 * `learningGenerator` may be written as a plain true or false. Writing one of its numbers next to
 * that keeps the choice: the switch becomes `enabled` inside a mapping, rather than the write
 * failing or the switch being lost.
 */
function expandLearningSwitch(doc: Record<string, unknown>, path: readonly string[]): void {
	if (path[0] !== 'learningGenerator' || path.length < 2) return
	if (typeof doc.learningGenerator === 'boolean')
		doc.learningGenerator = { enabled: doc.learningGenerator }
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

/**
 * Checks a change the way a write would, and touches nothing. Desktop asks this before it shows a
 * confirmation, so a value that would be refused never costs the person a dialog.
 */
export function checkSetting(change: SettingChange, opts: UserConfigWriteOptions = {}): void {
	prepare(change, opts)
}

/**
 * The save-to-file destination cannot be removed alone: the loader refuses a `sessionExport`
 * block that has no destination. Clearing it removes the whole block, which is what stopping the
 * saving means; the choices beside it were only meaningful with a destination.
 */
const SESSION_EXPORT_DESTINATION = 'telemetry.sessionExport.destination'

function prepare(
	change: SettingChange,
	opts: UserConfigWriteOptions,
): { path: string[]; value: unknown | undefined } {
	const entry = descriptorFor(change.path)
	let path = entry.path.split('.')
	const file = userConfigPath(opts)
	const doc = readUserDocument(opts)
	if (change.value === undefined || change.value === null) {
		if (entry.control.kind === 'file-only') throw new Error('Edit this one in the config file.')
		if (entry.path === SESSION_EXPORT_DESTINATION) path = ['telemetry', 'sessionExport']
		expandLearningSwitch(doc, path)
		checkAcrossKeys(doc, path, undefined)
		checkWhole(doc, path, undefined, file)
		return { path, value: undefined }
	}
	const value = coerce(entry, change.value)
	VALUE_CHECKS[entry.path]?.(value)
	expandLearningSwitch(doc, path)
	checkAcrossKeys(doc, path, value)
	checkWhole(doc, path, value, file)
	return { path, value }
}

export function writeSetting(change: SettingChange, opts: UserConfigWriteOptions = {}): void {
	const { path, value } = prepare(change, opts)
	// Make a plain `learningGenerator: true|false` a mapping first, so the number goes beside it.
	if (path[0] === 'learningGenerator' && path.length > 1) {
		const doc = readUserDocument(opts)
		if (typeof doc.learningGenerator === 'boolean')
			setUserConfigValue(['learningGenerator'], { enabled: doc.learningGenerator }, opts)
	}
	if (value === undefined) deleteUserConfigValue(path, opts)
	else setUserConfigValue(path, value, opts)
}
