/**
 * Numbers, times and confirmations of a described setting, in the words a screen shows.
 *
 * Desktop's Settings page (`desktop/src/renderer/config-settings-model.ts`) and its main process
 * (`desktop/src/main/config-settings.ts`) say the same things for the same inputs. Desktop cannot
 * import the CLI, so these are kept equivalent by a test in each package that feeds one table of
 * inputs to both. The terminal's `namzu config` and `/config <key>` read from here.
 */

import type { SettingDefault, SettingDescriptor } from './settings-descriptors.js'

const MS_UNITS = { h: 3_600_000, m: 60_000, s: 1_000 } as const

/** A time as a person writes it: `5m`, `90s`, `1h 30m`, `250ms`. A bare number is minutes. */
export function parseDuration(text: string): number | undefined {
	const t = text.trim().toLowerCase()
	if (t === '') return undefined
	if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t) * MS_UNITS.m)
	const match =
		/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?\s*(?:(\d+)\s*ms)?$/.exec(
			t,
		)
	if (!match) return undefined
	const [, h, m, s, ms] = match
	return Math.round(
		Number(h ?? 0) * MS_UNITS.h +
			Number(m ?? 0) * MS_UNITS.m +
			Number(s ?? 0) * MS_UNITS.s +
			Number(ms ?? 0),
	)
}

/** Milliseconds as hours, minutes and seconds: `5m`, `1m 30s`, `250ms`; 0 stays `0`. */
export function formatDuration(ms: number): string {
	if (ms === 0) return '0'
	const parts: string[] = []
	let rest = ms
	for (const [unit, size] of [
		['h', MS_UNITS.h],
		['m', MS_UNITS.m],
		['s', MS_UNITS.s],
	] as const) {
		const n = Math.floor(rest / size)
		if (n > 0) parts.push(`${n}${unit}`)
		rest -= n * size
	}
	if (rest > 0) parts.push(`${rest}ms`)
	return parts.join(' ')
}

/** A token count as written: `786k`, `1m`, `200000`. */
export function parseTokens(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text.trim().toLowerCase().replace(/,/g, ''))
	if (!match) return undefined
	const [, n, suffix] = match
	return Math.round(Number(n) * (suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1))
}

function formatTokens(value: number): string {
	if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`
	if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`
	return String(value)
}

/** A number as its box shows it: a time in minutes and seconds, anything else as it is. */
export function displayNumber(value: number, unit?: string): string {
	return unit === 'ms' ? formatDuration(value) : String(value)
}

function bound(value: number, unit?: string): string {
	return unit === 'ms'
		? formatDuration(value)
		: unit === 'tokens'
			? formatTokens(value)
			: String(value)
}

/** The range a number takes, as a short sentence; empty when it is any whole number from 0. */
export function rangeText(control: { min?: number; max?: number; unit?: string }): string {
	const { min, max, unit } = control
	if (unit === 'ms' && (max === undefined || max > 86_400_000)) return ''
	if (min !== undefined && max !== undefined)
		return `From ${bound(min, unit)} to ${bound(max, unit)}.`
	if (max !== undefined) return `Up to ${bound(max, unit)}.`
	if (min !== undefined && min > 0 && !(unit === 'ms' && min < 1000))
		return `At least ${bound(min, unit)}.`
	return ''
}

/**
 * A number's text to the number saved, or the sentence to show. A time takes minutes and seconds
 * and a token count takes 200k or 1m. The engine checks the same bounds again on the write.
 */
export function numberFromText(
	text: string,
	control: { min?: number; max?: number; unit?: string },
): { value: number } | { error: string } {
	const trimmed = text.trim()
	let value: number | undefined
	let wrong = 'Enter a number.'
	if (control.unit === 'ms') {
		value = parseDuration(trimmed)
		wrong = 'Enter minutes and seconds, such as 5m or 90s.'
	} else if (control.unit === 'tokens') {
		value = parseTokens(trimmed)
		wrong = 'Enter a number, such as 200000, 200k or 1m.'
	} else if (trimmed !== '' && Number.isFinite(Number(trimmed))) value = Number(trimmed)
	if (value === undefined || !Number.isFinite(value)) return { error: wrong }
	if (control.min !== undefined && value < control.min)
		return { error: `Enter ${bound(control.min, control.unit)} or more.` }
	if (control.max !== undefined && value > control.max)
		return { error: `Enter ${bound(control.max, control.unit)} or less.` }
	return { value }
}

/**
 * Whether a change needs the person's yes. Clearing a setting puts the default back, so it asks
 * unless the descriptor names the risky values and the default is none of them. Otherwise the
 * descriptor says which new value asks. A value is `undefined` for a clear.
 */
export function needsConfirmation(entry: SettingDescriptor, value: unknown): boolean {
	if (!entry.confirm) return false
	if (value === undefined) return clearReachesRiskyDefault(entry)
	if (entry.confirmValues !== undefined) return entry.confirmValues.includes(value as string)
	if (entry.confirmValue !== undefined) return value === entry.confirmValue
	if (!entry.confirmWhen) return true
	if (entry.confirmWhen === 'zero') return value === 0
	if (typeof value !== 'boolean') return true
	return value === (entry.confirmWhen === 'on')
}

function clearReachesRiskyDefault(entry: SettingDescriptor): boolean {
	if (
		(entry.confirmWhen === 'on' || entry.confirmWhen === 'off') &&
		typeof entry.default === 'boolean' &&
		!entry.defaultWhen?.length
	)
		return entry.default === (entry.confirmWhen === 'on')
	const risky =
		entry.confirmValues ?? (entry.confirmValue !== undefined ? [entry.confirmValue] : undefined)
	if (risky === undefined || entry.defaultWhen?.length) return true
	if (typeof entry.default !== 'string') return true
	return risky.includes(entry.default)
}

/**
 * What the setting holds with nothing saved: the typed default, or the rule that applies when one
 * of the settings it depends on is set. `saved` answers a path with the value in the user file.
 */
export function effectiveDefault(
	entry: SettingDescriptor,
	saved: (path: string) => { set: boolean; value?: unknown },
): SettingDefault | undefined {
	for (const rule of entry.defaultWhen ?? []) {
		const state = saved(rule.path)
		if (!state.set) continue
		const value = state.value
		const hit =
			rule.is === 'non-empty'
				? Array.isArray(value)
					? value.length > 0
					: value !== undefined && value !== null && value !== '' && value !== false
				: value === rule.is
		if (hit) return rule.value
	}
	return entry.default
}

/** The default as a person reads it: on, off, a number with its unit, an option's label. */
export function defaultWords(
	entry: SettingDescriptor,
	saved: (path: string) => { set: boolean; value?: unknown },
): string {
	const value = effectiveDefault(entry, saved)
	const control = entry.control
	if (value === undefined) return entry.defaultText ?? 'not set'
	let text: string
	if (typeof value === 'boolean') text = value ? 'on' : 'off'
	else if (Array.isArray(value)) {
		const options = control.kind === 'checks' ? control.options : []
		text =
			value.length === 0
				? 'none'
				: value.map((item) => options.find((o) => o.value === item)?.label ?? item).join(', ')
	} else if (typeof value === 'number') {
		if (control.kind === 'number' && control.unit === 'ms') text = formatDuration(value)
		else
			text = control.kind === 'number' && control.unit ? `${value} ${control.unit}` : String(value)
	} else if (control.kind === 'select')
		text = control.options.find((o) => o.value === value)?.label ?? String(value)
	else text = String(value)
	return entry.defaultNote ? `${text}. ${entry.defaultNote}` : text
}

/** A saved value as a person reads it. A list or table is shown as compact JSON, cut when long. */
export function valueWords(entry: SettingDescriptor, value: unknown): string {
	const control = entry.control
	if (typeof value === 'boolean') return value ? 'on' : 'off'
	if (typeof value === 'number')
		return control.kind === 'number' && control.unit === 'ms'
			? formatDuration(value)
			: control.kind === 'number' && control.unit && control.unit !== 'tokens'
				? `${value} ${control.unit}`
				: String(value)
	if (typeof value === 'string') {
		if (control.kind === 'select')
			return control.options.find((o) => o.value === value)?.label ?? value
		return value
	}
	if (Array.isArray(value) && control.kind === 'checks') {
		if (value.length === 0) return 'none'
		return value
			.map((item) => control.options.find((o) => o.value === item)?.label ?? String(item))
			.join(', ')
	}
	const json = JSON.stringify(value)
	return json.length > 80 ? `${json.slice(0, 77)}...` : json
}
