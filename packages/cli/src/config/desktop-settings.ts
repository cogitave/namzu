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

import { parsePrefix } from '../workspaces/prefix.js'
import { BROWSER_PROFILE_NAME, ConfigValueError, readConfigKey } from './load.js'
import {
	levelsValue,
	listControlWords,
	sameSet,
	screenNames,
	screenTools,
	screensValue,
} from './setting-values.js'
import {
	SETTING_DESCRIPTORS,
	SETTING_GROUP_LABELS,
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
export function withDefaultText(
	entry: SettingDescriptor,
): SettingDescriptor & { readonly groupLabel?: string } {
	const filled = withTypedDefaultText(entry)
	// Sent with the id so a screen draws the heading without a second copy of the words.
	return entry.group ? { ...filled, groupLabel: SETTING_GROUP_LABELS[entry.group] } : filled
}

function withTypedDefaultText(entry: SettingDescriptor): SettingDescriptor {
	if (entry.defaultText !== undefined || entry.default === undefined) return entry
	const control = entry.control
	const value = entry.default
	let text: string
	const listed = listControlWords(control, value)
	if (listed !== undefined) text = listed
	else if (typeof value === 'boolean') text = value ? 'on' : 'off'
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

function wordsList(raw: unknown, what: string): string[] {
	if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) throw new Error(what)
	return raw as string[]
}

function choosable(values: readonly string[], allowed: readonly string[]): void {
	if (values.some((v) => !allowed.includes(v)))
		throw new Error(`Choose from: ${allowed.join(', ')}.`)
}

/**
 * A value read as its control reads it. `undefined` comes back for a value that means the same as
 * the key being absent (every event ticked, every trigger at its default), so the key is removed
 * rather than written with a list that would stop following the default.
 */
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
			const list = wordsList(raw, 'Choose from the list.')
			const allowed = control.options.map((o) => o.value)
			choosable(list, allowed)
			// With every choice ticked, nothing is saved: a missing key means all, new kinds too.
			if (control.allLabel && sameSet(list, allowed)) return undefined
			return list
		}
		case 'toggle-checks': {
			if (typeof raw === 'boolean') return raw
			const list = wordsList(raw, 'Choose on, off or events from the list.')
			choosable(
				list,
				control.options.map((o) => o.value),
			)
			return list
		}
		case 'toggle-list': {
			const list = wordsList(raw, 'Choose on or off.')
			if (sameSet(list, control.on)) return [...control.on]
			if (sameSet(list, control.off)) return [...control.off]
			throw new Error('Choose on or off.')
		}
		case 'key': {
			if (typeof raw !== 'string') throw new Error('Choose a key.')
			// The loader's own reader names the keys it refuses; this only spells the key as it writes it.
			return parsePrefix(raw)?.name ?? raw.trim()
		}
		case 'levels': {
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
				throw new Error('Choose a level for each entry.')
			const ids = control.entries.map((e) => e.value)
			const levels = control.levels.map((l) => l.value)
			for (const [id, level] of Object.entries(raw)) {
				if (!ids.includes(id)) throw new Error(`Choose from: ${ids.join(', ')}.`)
				if (typeof level !== 'string' || !levels.includes(level))
					throw new Error(`Choose a level for ${id}: ${levels.join(', ')}.`)
			}
			return levelsValue(raw as Record<string, string>, entry.default)
		}
		case 'screens': {
			if (!Array.isArray(raw)) throw new Error('Choose from the list.')
			const allowed = control.options.map((o) => o.value)
			const names = screenNames(raw)
			if (names.length !== raw.length) throw new Error('Choose from the list.')
			choosable(names, allowed)
			const { screen, field } = control.passthrough
			for (const entry of raw) {
				if (typeof entry === 'string') continue
				const { name, ...options } = entry as Record<string, unknown>
				for (const key of Object.keys(options))
					if (!(name === screen && key === field))
						throw new Error(`${key} is not an option of the "${String(name)}" screen.`)
				const tools = options[field]
				if (
					tools !== undefined &&
					(!Array.isArray(tools) || tools.some((t) => typeof t !== 'string'))
				)
					throw new Error(`${field} must be a list of tool names.`)
			}
			const tools = screenTools(raw, screen, field)
			if (tools.some((tool) => tool.trim() === '')) throw new Error('Enter a tool name.')
			// An exemption on a screen that is not ticked has nothing to attach to.
			if (tools.length > 0 && !names.includes(screen))
				throw new Error(`${field} belongs to the ${screen} screen, which is not chosen.`)
			return screensValue(names, tools, control, entry.default) === undefined
				? undefined
				: normaliseScreens(raw, screen, field)
		}
		case 'list': {
			const list = wordsList(raw, 'Enter a list of words.')
			if (list.some((item) => item.trim() === '' || item.length > 2000))
				throw new Error(`Enter a ${control.itemLabel} of 1 to 2000 characters.`)
			const words = list.map((item) => item.trim())
			// An empty list is the default for a setting whose default is none: the key goes.
			if (words.length === 0 && Array.isArray(entry.default) && entry.default.length === 0)
				return undefined
			return words
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

/** The list as written, with a screen's tools trimmed and deduplicated and blank ones dropped. */
function normaliseScreens(raw: unknown[], screen: string, field: string): unknown[] {
	return raw.map((entry) => {
		if (typeof entry === 'string') return entry
		const name = (entry as { name: string }).name
		if (name !== screen) return name
		const tools = [...new Set(screenTools([entry], screen, field).map((t) => t.trim()))]
		return tools.length > 0 ? { name, [field]: tools } : name
	})
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
	if (value === undefined) {
		// A value that means the same as no key: remove the key, as a clear does.
		checkAcrossKeys(doc, path, undefined)
		checkWhole(doc, path, undefined, file)
		return { path, value: undefined }
	}
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
