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
	needsConfirmation,
	numberFromText,
	rangeText,
	valueWords,
} from './setting-values.js'
import {
	APPLIES_WHEN_TEXT,
	type AppliesWhen,
	SETTING_DESCRIPTORS,
	type SettingDescriptor,
	type SettingSection,
} from './settings-descriptors.js'
import { type UserConfigWriteOptions, userConfigPath } from './user-config.js'

const APPLIES_SHORT: Readonly<Record<AppliesWhen, string>> = {
	now: 'at once',
	'next-turn': 'next message',
	'next-conversation': 'new conversations',
	'next-start': 'next start',
	'next-launch': 'next app launch',
}

export const SETTING_SECTIONS: readonly SettingSection[] = [
	'general',
	'models',
	'projects',
	'appearance',
	'updates',
	'agent',
	'tools',
	'telemetry',
	'terminal',
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
		appliesText: APPLIES_WHEN_TEXT[entry.appliesWhen],
		...(entry.confirm ? { confirm: entry.confirm, asksWhen: asksWhenWords(entry) } : {}),
		fileOnly,
	}
}

/** Which change asks first, in words: the risky choices, a switch's direction, or any change. */
function asksWhenWords(entry: SettingDescriptor): string {
	if (entry.confirmValues !== undefined) return `when set to ${entry.confirmValues.join(' or ')}`
	if (entry.confirmValue !== undefined) return `when set to ${entry.confirmValue}`
	if (entry.confirmWhen === 'zero') return 'when set to 0'
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
	const rows = SETTING_DESCRIPTORS.filter((entry) => !section || entry.section === section).map(
		(entry) => toRow(entry, byPath.get(entry.path), saved),
	)
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
		description: row.description,
		set: row.set,
		...(row.value !== undefined ? { value: row.value } : {}),
		...(row.default !== undefined ? { default: row.default } : {}),
		defaultText: row.defaultText,
		control,
		appliesWhen: row.appliesWhen,
		appliesText: row.appliesText,
		...(row.confirm ? { confirm: row.confirm, asksWhen: row.asksWhen } : {}),
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
	let section: SettingSection | undefined
	for (const row of rows) {
		if (row.section !== section) {
			if (section !== undefined) lines.push('')
			section = row.section
			lines.push(`[${section}]`)
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
		lines.push(control.kind === 'checks' ? 'Choices:  (give a comma list, or none)' : 'Choices:')
		const width = Math.max(...control.options.map((o) => o.value.length))
		for (const option of control.options)
			lines.push(
				`  ${option.value.padEnd(width)}  ${option.label}${option.help ? ` - ${option.help}` : ''}`,
			)
	} else if (control.kind === 'json') lines.push(`Takes:    JSON, such as ${control.example}`)
	else if (control.kind === 'text') lines.push('Takes:    text')
	else lines.push('Takes:    nothing here; edit this one in the config file')
	if (row.confirm) lines.push(`Asks:     ${row.asksWhen}: ${row.confirm}`)
	lines.push(`File:     ${file}`)
	return lines.join('\n')
}

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
			if (trimmed === '' || trimmed.toLowerCase() === 'none') return { value: [] }
			const items = trimmed
				.split(',')
				.map((item) => item.trim())
				.filter((item) => item !== '')
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
		case 'text':
			return { value: text }
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
		!unchanged && needsConfirmation(entry, value) ? describeChange(key).confirm : undefined
	return {
		ok: true,
		entry,
		...(asks ? { confirm: asks } : {}),
		apply: () => {
			writeSetting({ path: key, ...(value !== undefined ? { value } : {}) }, opts)
			const row = readSettingRow(key, opts)
			const head =
				text === undefined
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
