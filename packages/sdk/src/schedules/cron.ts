/**
 * Five-field cron, parsed into sets.
 *
 * Minute, hour, day of month, month, day of week. Lists, ranges, steps and
 * three-letter names; `0` and `7` are both Sunday. Vixie semantics for the
 * two day fields: when BOTH are restricted a day matches if EITHER does, which
 * is what every cron and every existing crontab assumes.
 *
 * Refused, each by name: `L`, `W`, `#`, `?`, a sixth (seconds) field and
 * `@reboot`. A refused token is a better answer than a job that silently
 * means something the operator did not write.
 */

import { ScheduleValidationError } from './errors.js'
import type { CronExpression } from './types.js'

const MACROS: Readonly<Record<string, string>> = {
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
	'@monthly': '0 0 1 * *',
	'@weekly': '0 0 * * 0',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@hourly': '0 * * * *',
}

const MONTH_NAMES = [
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec',
]
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
	readonly label: string
	readonly min: number
	readonly max: number
	readonly names?: readonly string[]
	/** Where `names[0]` sits in the numeric range. */
	readonly nameBase?: number
}

const FIELDS: readonly FieldSpec[] = [
	{ label: 'minute', min: 0, max: 59 },
	{ label: 'hour', min: 0, max: 23 },
	{ label: 'day of month', min: 1, max: 31 },
	{ label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
	{ label: 'day of week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
]

function parseValue(raw: string, field: FieldSpec): number {
	const lower = raw.toLowerCase()
	if (field.names) {
		const at = field.names.indexOf(lower)
		if (at >= 0) return at + (field.nameBase ?? 0)
	}
	if (!/^\d+$/.test(raw)) {
		throw new ScheduleValidationError(`${field.label}: "${raw}" is not a number or a name`, raw)
	}
	const n = Number(raw)
	if (n < field.min || n > field.max) {
		throw new ScheduleValidationError(
			`${field.label}: ${n} is outside ${field.min}-${field.max}`,
			raw,
		)
	}
	return n
}

function parseField(text: string, field: FieldSpec): number[] {
	if (text === '') throw new ScheduleValidationError(`${field.label}: empty field`, text)
	const values = new Set<number>()
	for (const part of text.split(',')) {
		if (part === '') throw new ScheduleValidationError(`${field.label}: empty list entry`, text)
		// Names (`jul`, `wed`) are removed first: they carry the letters the
		// refused `L` and `W` are spelled with.
		const withoutNames = part.replace(/[a-z]{3}/gi, (word) =>
			field.names?.includes(word.toLowerCase()) ? '' : word,
		)
		for (const refused of ['L', 'W', '#', '?']) {
			if (withoutNames.toUpperCase().includes(refused)) {
				throw new ScheduleValidationError(
					`${field.label}: "${refused}" is not supported (in "${part}")`,
					refused,
				)
			}
		}
		const [rangeText = '', stepText, extra] = part.split('/')
		if (extra !== undefined) {
			throw new ScheduleValidationError(`${field.label}: "${part}" has more than one step`, part)
		}
		let step = 1
		if (stepText !== undefined) {
			if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
				throw new ScheduleValidationError(
					`${field.label}: step "${stepText}" must be a whole number above 0`,
					part,
				)
			}
			step = Number(stepText)
		}
		let lo: number
		let hi: number
		if (rangeText === '*') {
			lo = field.min
			hi = field.label === 'day of week' ? 6 : field.max
		} else if (rangeText.includes('-')) {
			const [a = '', b = '', more] = rangeText.split('-')
			if (more !== undefined) {
				throw new ScheduleValidationError(`${field.label}: "${rangeText}" is not a range`, part)
			}
			lo = parseValue(a, field)
			hi = parseValue(b, field)
			if (hi < lo) {
				throw new ScheduleValidationError(
					`${field.label}: range "${rangeText}" runs backwards`,
					rangeText,
				)
			}
		} else {
			lo = parseValue(rangeText, field)
			// `5/15` means "from 5, every 15", as in Vixie cron.
			hi = stepText !== undefined ? (field.label === 'day of week' ? 6 : field.max) : lo
		}
		for (let v = lo; v <= hi; v += step) values.add(v)
	}
	return [...values].sort((a, b) => a - b)
}

/**
 * Parse a five-field expression or a macro. Throws
 * {@link ScheduleValidationError} naming the offending token.
 */
export function parseCronExpression(input: string): CronExpression {
	const trimmed = input.trim()
	if (trimmed === '') throw new ScheduleValidationError('empty cron expression', '')
	let text = trimmed
	if (trimmed.startsWith('@')) {
		const macro = MACROS[trimmed.toLowerCase()]
		if (!macro) {
			throw new ScheduleValidationError(`"${trimmed}" is not a supported macro`, trimmed)
		}
		text = macro
	}
	const fields = text.split(/\s+/)
	if (fields.length === 6) {
		throw new ScheduleValidationError(
			'six fields: a seconds field is not supported; use five fields (minute hour day month weekday)',
			fields[0],
		)
	}
	if (fields.length !== 5) {
		throw new ScheduleValidationError(
			`expected five fields (minute hour day month weekday), got ${fields.length}`,
			text,
		)
	}
	const [mi = '', ho = '', dom = '', mon = '', dow = ''] = fields
	const minutes = parseField(mi, FIELDS[0] as FieldSpec)
	const hours = parseField(ho, FIELDS[1] as FieldSpec)
	const daysOfMonth = parseField(dom, FIELDS[2] as FieldSpec)
	const months = parseField(mon, FIELDS[3] as FieldSpec)
	const weekdays = parseField(dow, FIELDS[4] as FieldSpec)
	const normalizedWeekdays = [...new Set(weekdays.map((d) => (d === 7 ? 0 : d)))].sort(
		(a, b) => a - b,
	)
	const fixedTime = !/[*/]/.test(mi) && !/[*/]/.test(ho)
	return {
		source: fields.join(' '),
		minutes,
		hours,
		daysOfMonth,
		months,
		daysOfWeek: normalizedWeekdays,
		domRestricted: !dom.startsWith('*'),
		dowRestricted: !dow.startsWith('*'),
		fixedTime,
	}
}

/** Whether the civil date matches the day fields (Vixie OR rule). */
export function cronMatchesDay(
	expr: CronExpression,
	month: number,
	day: number,
	weekday: number,
): boolean {
	if (!expr.months.includes(month)) return false
	const domMatch = expr.daysOfMonth.includes(day)
	const dowMatch = expr.daysOfWeek.includes(weekday)
	if (expr.domRestricted && expr.dowRestricted) return domMatch || dowMatch
	return domMatch && dowMatch
}
