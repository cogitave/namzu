/**
 * A schedule in words, for a confirmation screen or a listing.
 *
 * Covers the common shapes exactly and falls back to the expression itself
 * for anything else, rather than paraphrasing it wrongly.
 */

import { parseCronExpression } from './cron.js'
import type { CronExpression, ScheduleSpec } from './types.js'
import { formatWall } from './tz.js'

const MINUTE = 60_000
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
]

export interface DescribeScheduleOptions {
	/** Zone an `at` or `every` anchor is shown in. Default UTC. */
	readonly tz?: string
}

function pad(n: number): string {
	return String(n).padStart(2, '0')
}

function plural(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`
}

function describeInterval(ms: number): string {
	if (ms % (7 * 24 * 60 * MINUTE) === 0) {
		const w = ms / (7 * 24 * 60 * MINUTE)
		return w === 1 ? 'every week' : `every ${plural(w, 'week')}`
	}
	if (ms % (24 * 60 * MINUTE) === 0) {
		const d = ms / (24 * 60 * MINUTE)
		return d === 1 ? 'every 24 hours' : `every ${plural(d, 'day')}`
	}
	if (ms % (60 * MINUTE) === 0) {
		const h = ms / (60 * MINUTE)
		return h === 1 ? 'every hour' : `every ${plural(h, 'hour')}`
	}
	const m = ms / MINUTE
	return m === 1 ? 'every minute' : `every ${plural(m, 'minute')}`
}

/** `1,2,3,5` → `1–3, 5`. */
function ranges(values: readonly number[], name: (n: number) => string): string {
	const out: string[] = []
	let i = 0
	while (i < values.length) {
		let j = i
		while (j + 1 < values.length && (values[j + 1] as number) === (values[j] as number) + 1) j++
		const a = values[i] as number
		const b = values[j] as number
		if (j - i >= 2) out.push(`${name(a)} through ${name(b)}`)
		else for (let k = i; k <= j; k++) out.push(name(values[k] as number))
		i = j + 1
	}
	return out.join(', ')
}

function isFull(values: readonly number[], min: number, max: number): boolean {
	return values.length === max - min + 1
}

function describeDays(e: CronExpression): string {
	const allDom = !e.domRestricted
	const allDow = !e.dowRestricted
	const allMonths = isFull(e.months, 1, 12)
	let days: string
	if (allDom && allDow) days = 'every day'
	else if (allDom) days = `on ${ranges(e.daysOfWeek, (d) => DAY_NAMES[d] ?? String(d))}`
	else if (allDow) days = `on day ${ranges(e.daysOfMonth, String)} of the month`
	else
		days = `on day ${ranges(e.daysOfMonth, String)} of the month and on ${ranges(e.daysOfWeek, (d) => DAY_NAMES[d] ?? String(d))}`
	if (!allMonths) days += ` in ${ranges(e.months, (m) => MONTH_NAMES[m - 1] ?? String(m))}`
	return days
}

function describeTimes(e: CronExpression, source: string): string {
	const [mi = '', ho = ''] = source.split(' ')
	const allMinutes = isFull(e.minutes, 0, 59)
	const allHours = isFull(e.hours, 0, 23)
	if (allMinutes && allHours) return 'every minute'
	const stepMinute = /^\*\/(\d+)$/.exec(mi)
	if (stepMinute && allHours) return `every ${plural(Number(stepMinute[1]), 'minute')}`
	if (allHours && e.minutes.length <= 4) {
		return e.minutes.length === 1 && e.minutes[0] === 0
			? 'every hour, on the hour'
			: `every hour at minute ${e.minutes.join(', ')}`
	}
	const stepHour = /^\*\/(\d+)$/.exec(ho)
	if (stepHour && e.minutes.length === 1) {
		return `every ${plural(Number(stepHour[1]), 'hour')} at minute ${e.minutes[0]}`
	}
	if (e.hours.length * e.minutes.length <= 6) {
		const times: string[] = []
		for (const h of e.hours) for (const m of e.minutes) times.push(`${pad(h)}:${pad(m)}`)
		return `at ${times.join(', ')}`
	}
	return `at minute ${ranges(e.minutes, String)} of hour ${ranges(e.hours, String)}`
}

/** The schedule in words: `at 03:00 every day (Europe/Istanbul)`. */
export function describeSchedule(
	spec: ScheduleSpec,
	options: DescribeScheduleOptions = {},
): string {
	const tz = options.tz ?? 'UTC'
	switch (spec.kind) {
		case 'at':
			return `once at ${formatWall(Date.parse(spec.at), tz)} (${tz})`
		case 'every':
			return describeInterval(spec.everyMs)
		case 'cron': {
			let e: CronExpression
			try {
				e = parseCronExpression(spec.expr)
			} catch {
				return `cron "${spec.expr}" (${spec.tz})`
			}
			return `${describeTimes(e, e.source)} ${describeDays(e)} (${spec.tz})`
		}
	}
}
