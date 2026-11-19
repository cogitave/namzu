/**
 * One reader and one writer of the described settings for the terminal: `namzu config` and
 * `/config <key>` both go through here, and here goes through the same checks Desktop's Settings
 * page runs (`desktop-settings.ts`), so a value Desktop refuses is refused with the same text.
 *
 * Nothing in this file lists a setting. It reads `SETTING_DESCRIPTORS` (through `readSettings`),
 * so a setting added there is listed, shown, set and cleared here with no second edit.
 */

import {
	type SettingState,
	checkSetting,
	describeChange,
	readSettings,
	writeSetting,
} from './desktop-settings.js'
import {
	defaultWords,
	effectiveDefault,
	environmentNote,
	layerNote,
	levelsHeld,
	loosenConfirmation,
	needsConfirmation,
	numberFromText,
	rangeText,
	turnedOffNote,
	valueWords,
	widenedConfirmation,
} from './setting-values.js'
import {
	type AppliesWhen,
	SETTING_DESCRIPTORS,
	SETTING_GROUP_LABELS,
	type SettingDescriptor,
	type SettingGroup,
	type SettingOption,
	type SettingSection,
	appliesTextFor,
} from './settings-descriptors.js'
import { type UserConfigWriteOptions, userConfigPath } from './user-config.js'

const APPLIES_SHORT: Readonly<Record<AppliesWhen, string>> = {
	now: 'at once',
	'next-turn': 'next message',
	'next-conversation': 'new conversations',
	'next-start': 'next start',
	'next-launch': 'next app launch',
}

/** In the order of the Desktop Settings nav, so the list reads the same in both places. */
export const SETTING_SECTIONS: readonly SettingSection[] = [
	'models',
	'general',
	'appearance',
	'agent',
	'tools',
	'projects',
	'terminal',
	'telemetry',
	'updates',
]

export function isSettingSection(name: string): name is SettingSection {
	return (SETTING_SECTIONS as readonly string[]).includes(name)
}

export function findSetting(key: string): SettingDescriptor | undefined {
	return SETTING_DESCRIPTORS.find((entry) => entry.path === key)
}

function editDistance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i)
	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0] as number
		row[0] = i
		for (let j = 1; j <= b.length; j++) {
			const above = row[j] as number
			row[j] = Math.min(
				above + 1,
				(row[j - 1] as number) + 1,
				diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
			)
			diagonal = above
		}
	}
	return row[b.length] as number
}

/** True when the letters of `short` appear in `long` in order, as in an abbreviation. */
function isSubsequence(short: string, long: string): boolean {
	let at = 0
	for (const letter of long) if (letter === short[at]) at++
	return at === short.length
}

/** The closest setting names to a key that is not one: a shared part first, then spelling. */
export function closestSettings(key: string, count = 3): string[] {
	const needle = key.toLowerCase()
	// Words of the typed text, with camelCase split, so "helpersAtOnce" and "helpers at once" both match a label.
	const words = key
		.slice(key.indexOf('.') + 1)
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 3)
	const scored = SETTING_DESCRIPTORS.map((entry) => {
		const path = entry.path.toLowerCase()
		const label = entry.label.toLowerCase()
		const shares =
			needle.length >= 3 &&
			(path.includes(needle) || needle.includes(path) || label.includes(needle))
		const last = path.split('.').pop() as string
		const tail = needle.split('.').pop() as string
		const prefix =
			tail.length >= 2 &&
			needle.includes('.') &&
			path.split('.').slice(0, -1).join('.') === needle.split('.').slice(0, -1).join('.') &&
			isSubsequence(tail, last)
		const wordsHit = words.length > 0 && words.every((word) => label.includes(word))
		const distance = Math.min(
			editDistance(needle, path),
			tail.length >= 3 ? editDistance(tail, last) + 1 : Number.POSITIVE_INFINITY,
		)
		const score = prefix
			? distance - 300
			: wordsHit
				? distance - 200
				: shares
					? distance - 100
					: distance
		return { path: entry.path, score }
	})
	scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
	const limit = Math.max(3, Math.ceil(needle.length / 2))
	return scored
		.filter((item) => item.score <= limit)
		.slice(0, count)
		.map((item) => item.path)
}

export function unknownSettingMessage(key: string): string {
	const near = closestSettings(key)
	return near.length > 0
		? `${key} is not a setting Namzu describes. The closest are: ${near.join(', ')}.`
		: `${key} is not a setting Namzu describes. List them with: namzu config list`
}

export interface SettingRow {
	readonly key: string
	readonly label: string
	readonly section: SettingSection
	/** The heading it sits under inside its section, when it has one. */
	readonly group?: SettingGroup
	readonly description: string
	/** Written in the user file. False means the default applies. */
	readonly set: boolean
	/** The saved value as data. Absent when not set, and never present for a file-only row. */
	readonly value?: unknown
	/** The value in force as a person reads it: the saved one, or `default`. */
	readonly valueText: string
	readonly default?: SettingDescriptor['default']
	readonly defaultText: string
	readonly control: SettingDescriptor['control']
	readonly appliesWhen: AppliesWhen
	readonly appliesText: string
	readonly confirm?: string
	/** Which change asks first, in words. Present with `confirm`. */
	readonly asksWhen?: string
	readonly fileOnly: boolean
	/** A variable in the environment that is used in place of the saved value. */
	readonly env?: { readonly variable: string; readonly value: string }
	/** The layer that decides the value when it is not the user file, and the value it gives. */
	readonly layer?: SettingState['layer']
	readonly effective?: unknown
	/** `effective` in words, for the line that says what is in force. */
	readonly effectiveText?: string
	/** Who has forbidden the mode this row opts into, which beats the opt-in. */
	readonly turnedOffBy?: SettingState['turnedOffBy']
}

function toRow(
	entry: SettingDescriptor,
	state: SettingState | undefined,
	saved: (path: string) => { set: boolean; value?: unknown },
): SettingRow {
	const fileOnly = entry.control.kind === 'file-only'
	const set = state?.set === true
	const typed = effectiveDefault(entry, saved)
	return {
		key: entry.path,
		label: entry.label,
		section: entry.section,
		...(entry.group ? { group: entry.group } : {}),
		description: entry.description,
		set,
		...(set && !fileOnly && state?.value !== undefined ? { value: state.value } : {}),
		valueText: !set
			? 'default'
			: fileOnly
				? 'set (edit the config file to see it)'
				: valueWords(entry, state?.value),
		...(typed !== undefined ? { default: typed } : {}),
		defaultText: defaultWords(entry, saved),
		control: entry.control,
		appliesWhen: entry.appliesWhen,
		appliesText: appliesTextFor(entry),
		...(entry.confirm ? { confirm: entry.confirm, asksWhen: asksWhenWords(entry) } : {}),
		fileOnly,
		...(state?.env ? { env: state.env } : {}),
		...(state?.layer ? { layer: state.layer } : {}),
		...(state?.turnedOffBy ? { turnedOffBy: state.turnedOffBy } : {}),
		...(state?.effective !== undefined
			? {
					effective: state.effective,
					effectiveText: valueWords(entry, state.effective),
				}
			: {}),
	}
}

/** Which change asks first, in words: the risky choices, a switch's direction, or any change. */
function asksWhenWords(entry: SettingDescriptor): string {
	if (entry.confirmValues !== undefined) return `when set to ${entry.confirmValues.join(' or ')}`
	if (entry.confirmValue !== undefined) return `when set to ${entry.confirmValue}`
	if (entry.confirmWhen === 'zero') return 'when set to 0'
	if (entry.confirmWhen === 'widens') return 'when an entry is added'
	if (entry.confirmWhen === 'loosens') {
		switch (entry.control.kind) {
			case 'permission-rules':
				return 'when a rule lets more run without asking: an allow rule added, a rule made more permissive, or a deny or ask rule removed'
			case 'permission-checks':
				return 'when a check is removed or changed'
			case 'sites':
				return 'when a site becomes act, or a denied site is opened'
			default:
				return 'when the model changes or a list lets more run without asking you'
		}
	}
	if (entry.confirmWhen === 'on' || entry.confirmWhen === 'off')
		return `when turned ${entry.confirmWhen}`
	return 'on any change'
}

export function listSettings(
	opts: UserConfigWriteOptions = {},
	section?: SettingSection,
): { readonly file: string; readonly rows: readonly SettingRow[] } {
	const snapshot = readSettings(opts)
	const byPath = new Map(snapshot.settings.map((state) => [state.path, state]))
	const saved = (path: string) => byPath.get(path) ?? { set: false }
	// Sections print in the order SETTING_SECTIONS names; inside one, the descriptors' own order.
	const rank = (name: SettingSection) => SETTING_SECTIONS.indexOf(name)
	const rows = SETTING_DESCRIPTORS.filter((entry) => !section || entry.section === section)
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => rank(a.entry.section) - rank(b.entry.section) || a.index - b.index)
		.map(({ entry }) => toRow(entry, byPath.get(entry.path), saved))
	return { file: snapshot.file, rows }
}

export function readSettingRow(key: string, opts: UserConfigWriteOptions = {}): SettingRow {
	const entry = findSetting(key)
	if (!entry) throw new Error(unknownSettingMessage(key))
	const snapshot = readSettings(opts)
	const byPath = new Map(snapshot.settings.map((state) => [state.path, state]))
	return toRow(entry, byPath.get(key), (path) => byPath.get(path) ?? { set: false })
}

/** The data `namzu config list --json` and `get --json` print for one row. */
export function rowData(row: SettingRow): Record<string, unknown> {
	const control = row.control
	return {
		key: row.key,
		label: row.label,
		section: row.section,
		...(row.group ? { group: row.group, groupLabel: SETTING_GROUP_LABELS[row.group] } : {}),
		description: row.description,
		set: row.set,
		...(row.value !== undefined ? { value: row.value } : {}),
		...(row.default !== undefined ? { default: row.default } : {}),
		defaultText: row.defaultText,
		control,
		appliesWhen: row.appliesWhen,
		appliesText: row.appliesText,
		...(row.confirm ? { confirm: row.confirm, asksWhen: row.asksWhen } : {}),
		...(row.env ? { env: row.env } : {}),
		...(row.layer ? { layer: row.layer } : {}),
		...(row.turnedOffBy ? { turnedOffBy: row.turnedOffBy } : {}),
		...(row.effective !== undefined ? { effective: row.effective } : {}),
	}
}

function shortDefault(row: SettingRow): string {
	const text = row.defaultText.replace(/\.\s.*$/, '').replace(/\.$/, '')
	return text.length > 40 ? `${text.slice(0, 37)}...` : text
}

function shortApplies(row: SettingRow): string {
	return APPLIES_SHORT[row.appliesWhen]
}

/** Every row on one line: key, label, value, default and when a change applies. */
export function renderSettingList(rows: readonly SettingRow[], file: string): string {
	const keyWidth = Math.max(...rows.map((row) => row.key.length), 3)
	const labelWidth = Math.max(...rows.map((row) => row.label.length), 5)
	const valueWidth = Math.min(Math.max(...rows.map((row) => row.valueText.length), 5), 40)
	const lines = [`Settings in ${file}`, '']
	if (rows.length === 0)
		lines.push('No settings in this section. Its settings moved: run namzu config list.')
	let section: SettingSection | undefined
	let group: SettingGroup | undefined
	for (const row of rows) {
		if (row.section !== section) {
			if (section !== undefined) lines.push('')
			section = row.section
			group = undefined
			lines.push(`[${section}]`)
		}
		if (row.group !== group) {
			group = row.group
			// The descriptors keep a section's rows together, ungrouped first, then each group in turn.
			if (group) lines.push(`  ${SETTING_GROUP_LABELS[group]}`)
		}
		lines.push(
			`  ${row.key.padEnd(keyWidth)}  ${row.label.padEnd(labelWidth)}  ${row.valueText.padEnd(valueWidth)}  default ${shortDefault(row)}; applies ${shortApplies(row)}`,
		)
	}
	lines.push('', `${rows.length} settings. Show one: namzu config get <key>`)
	return lines.join('\n')
}

/** One setting in full: value, default, range or choices, when a change applies and where it lives. */
export function renderSetting(row: SettingRow, file: string): string {
	const lines = [`${row.label} (${row.key})`, row.description, '']
	lines.push(
		`Value:    ${row.set ? row.valueText : `default (${row.defaultText})`}${row.set ? ' (set in the user file)' : ''}`,
	)
	if (row.effectiveText !== undefined) lines.push(`In force: ${row.effectiveText}`)
	if (row.turnedOffBy) lines.push(`Note:     ${turnedOffNote(row.turnedOffBy)}`)
	else if (row.layer && row.layer !== 'user' && row.env?.value !== '')
		lines.push(`Note:     ${layerNote(row.layer, row.env, row.set)}`)
	else if (row.env) lines.push(`Note:     ${environmentNote(row.env)}`)
	// When a change applies follows the default, as on the Desktop row.
	lines.push(`Default:  ${row.defaultText.replace(/\.$/, '')}. ${row.appliesText}`)
	const control = row.control
	if (control.kind === 'number') {
		const range = rangeText(control)
		if (range) lines.push(`Range:    ${range}`)
		if (control.unit === 'ms')
			lines.push('Takes:    a time, such as 5m, 90s or 1h 30m; a bare number is minutes')
		else if (control.unit === 'tokens') lines.push('Takes:    a number, such as 200000, 200k or 1m')
	} else if (control.kind === 'toggle') lines.push('Takes:    on or off')
	else if (control.kind === 'select' || control.kind === 'checks') {
		lines.push(
			control.kind === 'checks'
				? `Choices:  (give a comma list, none${control.allLabel ? ' or all' : ''})`
				: 'Choices:',
		)
		lines.push(...optionLines(control.options))
	} else if (control.kind === 'toggle-checks') {
		lines.push('Takes:    on, off, or a comma list of events (on means the first two below)')
		lines.push(...optionLines(control.options))
	} else if (control.kind === 'toggle-list') lines.push('Takes:    on or off')
	else if (control.kind === 'key') {
		lines.push(`Takes:    one of ${control.options.map((o) => o.value).join(', ')}`)
	} else if (control.kind === 'levels') {
		const [entry, level] = [control.entries[0]?.value, control.levels[0]?.value]
		lines.push(
			`Takes:    ${entry}=${level}, comma separated (entries not named keep their level), or JSON such as {"${entry}":"${level}"}`,
		)
		lines.push('Entries:')
		lines.push(...optionLines(control.entries))
		lines.push(`Levels:   ${control.levels.map((l) => l.value).join(', ')}`)
		lines.push('          An entry set to its default is left out of the file.')
	} else if (control.kind === 'screens') {
		lines.push('Takes:    a comma list of screens, none, or JSON for tools that pass through')
		lines.push(
			`          such as [{"name":"${control.passthrough.screen}","${control.passthrough.field}":["tool-name"]}]`,
		)
		lines.push('Screens:')
		lines.push(...optionLines(control.options))
	} else if (control.kind === 'list')
		lines.push(
			`Takes:    ${control.itemLabel}s, comma separated, none, or a JSON list (a name that holds a comma must be written as JSON)`,
		)
	else if (control.kind === 'json') lines.push(`Takes:    JSON, such as ${control.example}`)
	else if (control.kind === 'text') lines.push('Takes:    text')
	else if (control.kind === 'model')
		lines.push('Takes:    a model, as provider/model or just the model of your provider')
	else if (control.kind === 'routing' || control.kind === 'auto-mode') {
		lines.push(`Takes:    JSON, such as ${control.example}`)
		if (control.kind === 'auto-mode') {
			lines.push(
				'Lists:    a list left out keeps the built-in rules; a list you give replaces them;',
			)
			lines.push('          the entry $defaults stands for the built-in rules at that place.')
			lines.push(...optionLines(control.lists))
			lines.push(
				'Model:    provider/model, a bare model of your provider, or smallModel for the side model',
			)
		}
	} else if (
		control.kind === 'permission-rules' ||
		control.kind === 'permission-checks' ||
		control.kind === 'sites'
	) {
		lines.push(`Takes:    JSON, such as ${control.example}`)
		if (control.kind === 'permission-rules') {
			lines.push('          a tool name (as written in lower case, such as bash) and, inside it,')
			lines.push('          a pattern of its input with the answer. Only the rules are set here;')
			lines.push('          the permission modes have their own keys.')
			lines.push('Answers:')
			lines.push(...optionLines(control.effects))
		} else if (control.kind === 'permission-checks') {
			lines.push('          each check is a tool, the input it is called with (an object; for')
			lines.push(
				`          ${control.commandTools.join(', ')} the field ${control.commandField}) and the answer expected.`,
			)
			lines.push('Expected:')
			lines.push(...optionLines(control.effects))
		} else {
			lines.push('          a site as the engine matches it (with its scheme) and a level;')
			lines.push(
				`          * is every other site, and reads as ${control.defaultLevel} when left out.`,
			)
			lines.push('Levels:')
			lines.push(...optionLines(control.levels))
		}
	} else lines.push('Takes:    nothing here; edit this one in the config file')
	if (row.confirm) lines.push(`Asks:     ${row.asksWhen}: ${row.confirm}`)
	lines.push(`File:     ${file}`)
	return lines.join('\n')
}

function optionLines(options: readonly SettingOption[]): string[] {
	const width = Math.max(...options.map((o) => o.value.length))
	return options.map(
		(option) =>
			`  ${option.value.padEnd(width)}  ${option.label}${option.help ? ` - ${option.help}` : ''}`,
	)
}

/** A choice typed as its saved value or its label, either case; anything else is handed on as typed. */
function matchOption(options: readonly SettingOption[], text: string): string {
	const wanted = text.trim().toLowerCase()
	return (
		options.find((o) => o.value.toLowerCase() === wanted || o.label.toLowerCase() === wanted)
			?.value ?? text.trim()
	)
}

function words(text: string): string[] {
	return text
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '')
}

/** JSON when the text starts like JSON, so a malformed one is refused as JSON and not as a word. */
function jsonOrNothing(text: string): { value: unknown } | { error: string } | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return undefined
	try {
		return { value: JSON.parse(trimmed) as unknown }
	} catch (error) {
		return { error: `That is not valid JSON: ${(error as Error).message}` }
	}
}

const OFF_WORDS = new Set(['off', 'false', 'no', 'none', '0', ''])
const ON_WORDS = new Set(['on', 'true', 'yes', '1'])

const TOGGLE_WORDS: Readonly<Record<string, boolean>> = {
	on: true,
	true: true,
	yes: true,
	'1': true,
	off: false,
	false: false,
	no: false,
	'0': false,
}

/**
 * The text a person typed, read by the setting's control, as the value Desktop's write takes. A
 * choice that matches nothing is handed on as typed, so the write refuses it in Desktop's words.
 */
export function parseSettingText(
	entry: SettingDescriptor,
	text: string,
	opts: UserConfigWriteOptions = {},
): { value: unknown } | { error: string } {
	const control = entry.control
	switch (control.kind) {
		case 'toggle': {
			const word = TOGGLE_WORDS[text.trim().toLowerCase()]
			return word === undefined ? { error: 'Choose on or off.' } : { value: word }
		}
		case 'number':
			return numberFromText(text, control)
		case 'select': {
			const wanted = text.trim().toLowerCase()
			const hit = control.options.find(
				(o) => o.value.toLowerCase() === wanted || o.label.toLowerCase() === wanted,
			)
			return { value: hit ? hit.value : text.trim() }
		}
		case 'checks': {
			const trimmed = text.trim()
			const asJson = jsonOrNothing(trimmed)
			if (asJson) return asJson
			if (trimmed === '' || trimmed.toLowerCase() === 'none') return { value: [] }
			if (control.allLabel && trimmed.toLowerCase() === 'all')
				return { value: control.options.map((o) => o.value) }
			const items = words(trimmed)
			return {
				value: items.map((item) => {
					const wanted = item.toLowerCase()
					const hit = control.options.find(
						(o) => o.value.toLowerCase() === wanted || o.label.toLowerCase() === wanted,
					)
					return hit ? hit.value : item
				}),
			}
		}
		case 'toggle-checks': {
			const asJson = jsonOrNothing(text)
			if (asJson) return asJson
			const word = text.trim().toLowerCase()
			if (ON_WORDS.has(word)) return { value: true }
			if (OFF_WORDS.has(word)) return { value: false }
			return { value: words(text).map((item) => matchOption(control.options, item)) }
		}
		case 'toggle-list': {
			const asJson = jsonOrNothing(text)
			if (asJson) return asJson
			const word = text.trim().toLowerCase()
			if (ON_WORDS.has(word)) return { value: [...control.on] }
			if (OFF_WORDS.has(word)) return { value: [...control.off] }
			return { value: words(text) }
		}
		case 'key':
			return { value: matchOption(control.options, text.trim().replace(/\s+/g, '')) }
		case 'levels': {
			const asJson = jsonOrNothing(text)
			if (asJson) return asJson
			if (OFF_WORDS.has(text.trim().toLowerCase())) return { value: {} }
			// Entries not named here keep what they hold now; JSON and `off` replace the whole map.
			let saved: unknown
			try {
				saved = readSettings(opts).settings.find((s) => s.path === entry.path)?.value
			} catch {
				saved = undefined
			}
			const chosen: Record<string, string> = { ...levelsHeld(saved, entry.default) }
			for (const item of words(text)) {
				const at = item.indexOf('=')
				if (at < 0)
					return {
						error: `Write each as entry=level, such as ${control.entries[0]?.value}=${control.levels[0]?.value}.`,
					}
				chosen[matchOption(control.entries, item.slice(0, at))] = matchOption(
					control.levels,
					item.slice(at + 1),
				)
			}
			return { value: chosen }
		}
		case 'screens': {
			const asJson = jsonOrNothing(text)
			if (asJson) return asJson
			const trimmed = text.trim().toLowerCase()
			if (trimmed === '' || trimmed === 'none') return { value: [] }
			return { value: words(text).map((item) => matchOption(control.options, item)) }
		}
		case 'list': {
			const asJson = jsonOrNothing(text)
			if (asJson) return asJson
			// `none` is an empty list; an entry that is itself called none is written as JSON.
			const trimmed = text.trim().toLowerCase()
			if (trimmed === '' || trimmed === 'none') return { value: [] }
			return { value: words(text) }
		}
		case 'text':
			return { value: text }
		case 'model':
			return { value: text.trim() }
		case 'routing':
		case 'auto-mode':
		case 'permission-rules':
		case 'permission-checks':
		case 'sites': {
			const asJson = jsonOrNothing(text)
			if (asJson) return asJson
			return { error: `Give JSON, such as ${control.example}` }
		}
		case 'json':
			return { value: text }
		case 'file-only':
			return {
				error: `Edit this one in the config file (${userConfigPath(opts)}); it is not shown or changed here.`,
			}
	}
}

export type SettingPlan =
	| { readonly ok: false; readonly error: string }
	| {
			readonly ok: true
			readonly entry: SettingDescriptor
			/** The sentence to ask first. Absent means the change applies without asking. */
			readonly confirm?: string
			/** Writes the change and says what it did and when it applies. */
			readonly apply: () => string
	  }

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Checks a change the way Desktop does and touches nothing. `text` is what was typed; `undefined`
 * clears the setting (Use default). The result says whether to ask first and how to apply.
 */
export function planSettingChange(
	key: string,
	text: string | undefined,
	opts: UserConfigWriteOptions = {},
): SettingPlan {
	const entry = findSetting(key)
	if (!entry) return { ok: false, error: unknownSettingMessage(key) }
	let value: unknown
	if (text !== undefined) {
		const parsed = parseSettingText(entry, text, opts)
		if ('error' in parsed) return { ok: false, error: parsed.error }
		value = parsed.value
	} else if (entry.control.kind === 'file-only')
		return {
			ok: false,
			error: `Edit this one in the config file (${userConfigPath(opts)}); it is not shown or changed here.`,
		}
	try {
		checkSetting({ path: key, ...(value !== undefined ? { value } : {}) }, opts)
	} catch (error) {
		return { ok: false, error: (error as Error).message }
	}
	let state: SettingState | undefined
	try {
		state = readSettings(opts).settings.find((s) => s.path === key)
	} catch {
		state = undefined
	}
	let comparable = value
	if (entry.control.kind === 'json' && typeof value === 'string') {
		try {
			comparable = JSON.parse(value) as unknown
		} catch {
			comparable = value
		}
	}
	const unchanged =
		text === undefined
			? state?.set !== true
			: state?.set === true && sameValue(state.value, comparable)
	const asks =
		!unchanged && needsConfirmation(entry, value, state?.set ? state.value : entry.default)
			? entry.confirmWhen === 'widens' && entry.confirm
				? widenedConfirmation(entry.confirm, state?.set ? state.value : entry.default, value)
				: entry.confirmWhen === 'loosens' && entry.confirm
					? loosenConfirmation(entry, state?.set ? state.value : entry.default, value)
					: describeChange(key).confirm
			: undefined
	return {
		ok: true,
		entry,
		...(asks ? { confirm: asks } : {}),
		apply: () => {
			writeSetting({ path: key, ...(value !== undefined ? { value } : {}) }, opts)
			const row = readSettingRow(key, opts)
			const head =
				text === undefined || !row.set
					? `${row.label} is back to its default: ${row.defaultText.replace(/\.$/, '')}.`
					: `${row.label} is now ${row.valueText}.`
			return `${head} ${row.appliesText}`
		},
	}
}

/** What `namzu config get <key>` prints, as text. */
export function describeSetting(key: string, opts: UserConfigWriteOptions = {}): string {
	return renderSetting(readSettingRow(key, opts), userConfigPath(opts))
}
