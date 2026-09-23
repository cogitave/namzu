/**
 * When a spec fires: the next instant, the previous one, and how many fall
 * in a window.
 *
 * Cron is walked a local DAY at a time — never a minute at a time over years
 * — and a day with no DST change is computed arithmetically from one offset.
 * Only a day whose offset changes is examined slot by slot, and that is where
 * cronie's rule is applied:
 *
 * - a fixed-time expression (`30 2 * * *`) whose time falls in a
 *   spring-forward gap fires once, at the first instant after the gap;
 *   whose time is repeated by a fall-back fires once, at the first of the two;
 * - a wildcard or step expression (`0 * * * *`, `*\/15 * * * *`) fires at
 *   every instant whose wall time matches: the repeated hour runs twice and
 *   slots inside the gap do not exist.
 */

import { cronMatchesDay, parseCronExpression } from './cron.js'
import { ScheduleValidationError } from './errors.js'
import type { CronExpression, OccurrenceCount, ScheduleSpec } from './types.js'
import { civil, firstInstantAfterGap, instantsForWall, offsetAt, validateTimeZone } from './tz.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** How far ahead a cron search looks before deciding the expression never fires. */
export const CRON_HORIZON_DAYS = 366 * 5 + 2
/**
 * Occurrence counts stop here. Counting a day without a DST change costs one
 * multiplication, so the cap bounds the pathological case (a years-long gap
 * on a per-minute job) rather than the ordinary one.
 */
export const OCCURRENCE_COUNT_CAP = 100_000

const parsedCache = new Map<string, CronExpression>()

function cronOf(expr: string): CronExpression {
	let parsed = parsedCache.get(expr)
	if (!parsed) {
		parsed = parseCronExpression(expr)
		if (parsedCache.size > 256) parsedCache.clear()
		parsedCache.set(expr, parsed)
	}
	return parsed
}

/** The local-midnight wall value of the day containing `wall`. */
function dayStart(wall: number): number {
	return Math.floor(wall / DAY) * DAY
}

/**
 * Every instant the expression fires on one local day (`dayWall` is that
 * day's midnight as a wall value), ascending.
 */
export function cronInstantsOnDay(expr: CronExpression, tz: string, dayWall: number): number[] {
	const c = civil(dayWall)
	if (!cronMatchesDay(expr, c.month, c.day, c.weekday)) return []
	const before = offsetAt(dayWall - 14 * HOUR, tz)
	const after = offsetAt(dayWall + DAY + 14 * HOUR, tz)
	const out: number[] = []
	if (before === after) {
		for (const h of expr.hours)
			for (const m of expr.minutes) out.push(dayWall + h * HOUR + m * MINUTE - before)
		return out
	}
	// A day the offset changes on (or next to): slot by slot.
	const seen = new Set<number>()
	for (const h of expr.hours) {
		for (const m of expr.minutes) {
			const wall = dayWall + h * HOUR + m * MINUTE
			const instants = instantsForWall(wall, tz)
			if (instants.length === 0) {
				if (expr.fixedTime) {
					const shifted = firstInstantAfterGap(wall, tz)
					if (!seen.has(shifted)) {
						seen.add(shifted)
						out.push(shifted)
					}
				}
				continue
			}
			const chosen = expr.fixedTime ? instants.slice(0, 1) : instants
			for (const t of chosen) {
				if (seen.has(t)) continue
				seen.add(t)
				out.push(t)
			}
		}
	}
	return out.sort((a, b) => a - b)
}

function validEvery(spec: { everyMs: number; anchorAt: string }): number {
	const anchor = Date.parse(spec.anchorAt)
	if (!Number.isFinite(anchor)) {
		throw new ScheduleValidationError(`anchor "${spec.anchorAt}" is not a date`, spec.anchorAt)
	}
	if (!Number.isSafeInteger(spec.everyMs) || spec.everyMs < MINUTE || spec.everyMs % MINUTE !== 0) {
		throw new ScheduleValidationError(
			'an interval must be a whole number of minutes, at least one',
			String(spec.everyMs),
		)
	}
	return anchor
}

/**
 * The first instant strictly after `afterExclusive` at which `spec` fires,
 * or `null` when there is none (a past `at`, or a cron expression with no
 * occurrence in the next five years).
 */
export function nextFireTime(spec: ScheduleSpec, afterExclusive: Date): Date | null {
	const after = afterExclusive.getTime()
	switch (spec.kind) {
		case 'at': {
			const at = Date.parse(spec.at)
			return Number.isFinite(at) && at > after ? new Date(at) : null
		}
		case 'every': {
			const anchor = validEvery(spec)
			const k = after < anchor ? 1 : Math.floor((after - anchor) / spec.everyMs) + 1
			return new Date(anchor + Math.max(1, k) * spec.everyMs)
		}
		case 'cron': {
			const expr = cronOf(spec.expr)
			const tz = spec.tz
			// A day early: a gap-shifted or offset-crossing instant of the
			// previous local day can still lie after `after`.
			let day = dayStart(after + offsetAt(after, tz)) - DAY
			for (let i = 0; i <= CRON_HORIZON_DAYS; i++, day += DAY) {
				for (const t of cronInstantsOnDay(expr, tz, day)) if (t > after) return new Date(t)
			}
			return null
		}
	}
}

/**
 * The last instant at or before `atOrBefore` at which `spec` fired, or
 * `null` if none within the horizon (or before the anchor / the `at`).
 */
export function previousFireTime(spec: ScheduleSpec, atOrBefore: Date): Date | null {
	const before = atOrBefore.getTime()
	switch (spec.kind) {
		case 'at': {
			const at = Date.parse(spec.at)
			return Number.isFinite(at) && at <= before ? new Date(at) : null
		}
		case 'every': {
			const anchor = validEvery(spec)
			const k = Math.floor((before - anchor) / spec.everyMs)
			return k >= 1 ? new Date(anchor + k * spec.everyMs) : null
		}
		case 'cron': {
			const expr = cronOf(spec.expr)
			const tz = spec.tz
			let day = dayStart(before + offsetAt(before, tz)) + DAY
			for (let i = 0; i <= CRON_HORIZON_DAYS; i++, day -= DAY) {
				const instants = cronInstantsOnDay(expr, tz, day)
				for (let j = instants.length - 1; j >= 0; j--) {
					const t = instants[j] as number
					if (t <= before) return new Date(t)
				}
			}
			return null
		}
	}
}

/**
 * How many times `spec` fires in `(fromExclusive, toInclusive]`, with the
 * first and latest of them. Stops counting at `cap` (default 100 000) and
 * says so, without enumerating beyond it; the latest is exact either way.
 */
export function countOccurrences(
	spec: ScheduleSpec,
	fromExclusive: Date,
	toInclusive: Date,
	cap: number = OCCURRENCE_COUNT_CAP,
): OccurrenceCount {
	const from = fromExclusive.getTime()
	const to = toInclusive.getTime()
	if (to <= from) return { count: 0, capped: false }
	switch (spec.kind) {
		case 'at': {
			const at = Date.parse(spec.at)
			return at > from && at <= to
				? { count: 1, capped: false, first: new Date(at), latest: new Date(at) }
				: { count: 0, capped: false }
		}
		case 'every': {
			const anchor = validEvery(spec)
			const firstK = from < anchor ? 1 : Math.floor((from - anchor) / spec.everyMs) + 1
			const lastK = Math.floor((to - anchor) / spec.everyMs)
			if (lastK < Math.max(1, firstK)) return { count: 0, capped: false }
			const k0 = Math.max(1, firstK)
			const total = lastK - k0 + 1
			return {
				count: Math.min(total, cap),
				capped: total > cap,
				first: new Date(anchor + k0 * spec.everyMs),
				latest: new Date(anchor + lastK * spec.everyMs),
			}
		}
		case 'cron': {
			const expr = cronOf(spec.expr)
			const tz = spec.tz
			const latest = previousFireTime(spec, toInclusive)
			if (!latest || latest.getTime() <= from) return { count: 0, capped: false }
			const perUniformDay = expr.hours.length * expr.minutes.length
			let count = 0
			let first: number | undefined
			const lastDay = dayStart(to + offsetAt(to, tz)) + DAY
			for (let day = dayStart(from + offsetAt(from, tz)) - DAY; day <= lastDay; day += DAY) {
				const c = civil(day)
				if (!cronMatchesDay(expr, c.month, c.day, c.weekday)) continue
				const o1 = offsetAt(day - 14 * HOUR, tz)
				const o2 = offsetAt(day + DAY + 14 * HOUR, tz)
				const dayFirst = day - o1
				const dayLast = day + DAY - o1
				if (first !== undefined && o1 === o2 && dayFirst > from && dayLast <= to) {
					count += perUniformDay
				} else {
					for (const t of cronInstantsOnDay(expr, tz, day)) {
						if (t <= from || t > to) continue
						if (first === undefined) first = t
						count++
					}
				}
				if (count > cap) break
			}
			return {
				count: Math.min(count, cap),
				capped: count > cap,
				...(first !== undefined ? { first: new Date(first) } : {}),
				latest,
			}
		}
	}
}

/** Validate a spec as a whole: its zone, its expression, and that it can ever fire after `now`. */
export function assertSpecFires(spec: ScheduleSpec, now: Date): void {
	if (spec.kind === 'cron') {
		validateTimeZone(spec.tz)
		cronOf(spec.expr)
	}
	if (nextFireTime(spec, now) === null) {
		throw new ScheduleValidationError(
			spec.kind === 'at'
				? `${spec.at} is in the past`
				: `"${spec.kind === 'cron' ? spec.expr : ''}" never fires in the next five years`,
			spec.kind === 'cron' ? spec.expr : spec.kind === 'at' ? spec.at : undefined,
		)
	}
}
