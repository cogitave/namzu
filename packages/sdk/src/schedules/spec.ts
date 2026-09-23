/**
 * The words an operator or a model types for a schedule, turned into a spec.
 *
 * | Input | Spec |
 * |---|---|
 * | `at 2026-09-24T09:00`, `at 2026-09-24 09:00`, `at 09:00`, `in 30m` | `at` |
 * | an ISO instant with `Z` or an offset, with or without `at` | `at` |
 * | `every 30m`, `every 2h`, `every 1d`, `every 90m` | `every` |
 * | five-field cron, `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` | `cron` |
 *
 * A local time is read in `tz`. Nothing is rounded silently: `every 30s` is
 * refused and the refusal names the nearest interval that is allowed.
 */

import { parseCronExpression } from './cron.js'
import { ScheduleValidationError } from './errors.js'
import { assertSpecFires, nextFireTime } from './next-fire.js'
import type { ScheduleSpec } from './types.js'
import { civil, hostTimeZone, instantsForWall, validateTimeZone, wallOf } from './tz.js'

const MINUTE = 60_000
const UNIT_MS: Readonly<Record<string, number>> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: MINUTE,
	min: MINUTE,
	mins: MINUTE,
	minute: MINUTE,
	minutes: MINUTE,
	h: 60 * MINUTE,
	hr: 60 * MINUTE,
	hrs: 60 * MINUTE,
	hour: 60 * MINUTE,
	hours: 60 * MINUTE,
	d: 24 * 60 * MINUTE,
	day: 24 * 60 * MINUTE,
	days: 24 * 60 * MINUTE,
	w: 7 * 24 * 60 * MINUTE,
	week: 7 * 24 * 60 * MINUTE,
	weeks: 7 * 24 * 60 * MINUTE,
}

export interface ParseScheduleOptions {
	/** "Now", for `in …`, `at HH:MM` and the anchor of `every`. Default: the clock. */
	readonly now?: Date
	/** Zone a local time and a cron expression are read in. Default: the host's. */
	readonly tz?: string
}

/** `90m` → 5 400 000. Throws on anything else. */
export function parseDuration(text: string): number {
	const match = /^(\d+)\s*([a-z]+)$/i.exec(text.trim())
	const unit = match ? UNIT_MS[(match[2] ?? '').toLowerCase()] : undefined
	if (!match || unit === undefined) {
		throw new ScheduleValidationError(
			`"${text}" is not a duration (write it like 30m, 2h, 1d)`,
			text,
		)
	}
	return Number(match[1]) * unit
}

function formatInterval(ms: number): string {
	if (ms % (24 * 60 * MINUTE) === 0) return `${ms / (24 * 60 * MINUTE)}d`
	if (ms % (60 * MINUTE) === 0) return `${ms / (60 * MINUTE)}h`
	return `${ms / MINUTE}m`
}

function everySpec(text: string, now: Date): ScheduleSpec {
	const ms = parseDuration(text)
	if (ms < MINUTE) {
		throw new ScheduleValidationError(
			`every ${text} is shorter than the minimum interval; the nearest allowed is every 1m`,
			text,
		)
	}
	if (ms % MINUTE !== 0) {
		const down = Math.floor(ms / MINUTE) * MINUTE
		const up = down + MINUTE
		throw new ScheduleValidationError(
			`every ${text} is not a whole number of minutes; the nearest allowed are every ${formatInterval(down)} and every ${formatInterval(up)}`,
			text,
		)
	}
	const anchor = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE)
	return { kind: 'every', everyMs: ms, anchorAt: anchor.toISOString() }
}

/** Resolve a local `YYYY-MM-DD HH:MM` in `tz` to one instant (the earlier of two). */
function localToInstant(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
	tz: string,
	token: string,
): number {
	const wall = Date.UTC(y, mo - 1, d, h, mi)
	const c = civil(wall)
	if (c.year !== y || c.month !== mo || c.day !== d || h > 23 || mi > 59) {
		throw new ScheduleValidationError(`"${token}" is not a real date and time`, token)
	}
	const instants = instantsForWall(wall, tz)
	if (instants.length === 0) {
		throw new ScheduleValidationError(
			`"${token}" does not exist in ${tz} (the clocks skip it); pick a time outside the change`,
			token,
		)
	}
	return instants[0] as number
}

function atSpec(text: string, now: Date, tz: string): ScheduleSpec {
	const t = text.trim()
	// An instant with its own offset: taken as written.
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
		const at = Date.parse(t)
		if (!Number.isFinite(at)) throw new ScheduleValidationError(`"${t}" is not a date`, t)
		return { kind: 'at', at: new Date(at).toISOString() }
	}
	const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(t)
	if (full) {
		const [, y, mo, d, h, mi] = full.map(Number) as number[]
		const at = localToInstant(
			y as number,
			mo as number,
			d as number,
			h as number,
			mi as number,
			tz,
			t,
		)
		return { kind: 'at', at: new Date(at).toISOString() }
	}
	const clock = /^(\d{1,2}):(\d{2})$/.exec(t)
	if (clock) {
		const h = Number(clock[1])
		const mi = Number(clock[2])
		if (h > 23 || mi > 59) throw new ScheduleValidationError(`"${t}" is not a time of day`, t)
		// The next time the wall clock reads HH:MM, today or tomorrow.
		const today = civil(wallOf(now.getTime(), tz))
		for (let add = 0; add < 3; add++) {
			const day = new Date(Date.UTC(today.year, today.month - 1, today.day + add))
			const instants = instantsForWall(
				Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, mi),
				tz,
			)
			const first = instants.find((i) => i > now.getTime())
			if (first !== undefined) return { kind: 'at', at: new Date(first).toISOString() }
		}
		throw new ScheduleValidationError(`"${t}" does not occur in ${tz} in the next two days`, t)
	}
	throw new ScheduleValidationError(
		`"${t}" is not a time (write 2026-09-24 09:00, 09:00, or an ISO instant)`,
		t,
	)
}

/**
 * Parse schedule words into a spec, validated: the zone exists, the
 * expression parses, and the spec fires at least once after `now`.
 */
export function parseScheduleSpec(input: string, options: ParseScheduleOptions = {}): ScheduleSpec {
	const now = options.now ?? new Date()
	const tz = validateTimeZone(options.tz ?? hostTimeZone())
	const text = input.trim()
	if (text === '') throw new ScheduleValidationError('a schedule is required', '')
	let spec: ScheduleSpec
	const lower = text.toLowerCase()
	if (lower.startsWith('every ')) {
		spec = everySpec(text.slice(6).trim(), now)
	} else if (lower.startsWith('in ')) {
		const ms = parseDuration(text.slice(3).trim())
		if (ms < MINUTE) {
			throw new ScheduleValidationError(
				`in ${text.slice(3).trim()} is less than a minute away; the nearest allowed is in 1m`,
				text.slice(3).trim(),
			)
		}
		spec = { kind: 'at', at: new Date(now.getTime() + ms).toISOString() }
	} else if (lower.startsWith('at ')) {
		spec = atSpec(text.slice(3), now, tz)
	} else if (/^\d{4}-\d{2}-\d{2}T/i.test(text)) {
		spec = atSpec(text, now, tz)
	} else if (lower === '@reboot') {
		throw new ScheduleValidationError('@reboot is not supported: a job runs on a schedule', text)
	} else {
		const expr = parseCronExpression(text)
		spec = { kind: 'cron', expr: expr.source, tz }
	}
	assertSpecFires(spec, now)
	return spec
}

/** The next `count` fire times after `after`. */
export function upcomingFireTimes(spec: ScheduleSpec, after: Date, count = 3): Date[] {
	const out: Date[] = []
	let cursor = after
	for (let i = 0; i < count; i++) {
		const next = nextFireTime(spec, cursor)
		if (!next) break
		out.push(next)
		cursor = next
	}
	return out
}
