/**
 * Time-zone arithmetic over `Intl` alone.
 *
 * The SDK carries no time-zone database of its own: the runtime's ICU data is
 * the source, read through `Intl.DateTimeFormat#formatToParts`. Everything in
 * this file is expressed in "wall" milliseconds — a local date and time
 * written as if it were UTC (`Date.UTC(y, m - 1, d, h, min)`) — so local
 * arithmetic is plain integer arithmetic and only the conversions touch Intl.
 */

import { ScheduleValidationError } from './errors.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz)
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
		})
		formatters.set(tz, f)
	}
	return f
}

/**
 * Throw unless `tz` is an IANA zone this runtime knows. Returns the zone as
 * the runtime spells it (`europe/istanbul` → `Europe/Istanbul`).
 */
export function validateTimeZone(tz: string): string {
	if (typeof tz !== 'string' || tz.trim() === '') {
		throw new ScheduleValidationError('a time zone is required', String(tz))
	}
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone
	} catch {
		throw new ScheduleValidationError(`unknown time zone "${tz}"`, tz)
	}
}

/** The zone this host is in, as the runtime reports it. */
export function hostTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** The wall clock of `instant` in `tz`, as wall milliseconds (seconds dropped). */
export function wallOf(instant: number, tz: string): number {
	const parts = formatterFor(tz).formatToParts(new Date(instant))
	let year = 0
	let month = 1
	let day = 1
	let hour = 0
	let minute = 0
	for (const part of parts) {
		switch (part.type) {
			case 'year':
				year = Number(part.value)
				break
			case 'month':
				month = Number(part.value)
				break
			case 'day':
				day = Number(part.value)
				break
			case 'hour':
				hour = Number(part.value) % 24
				break
			case 'minute':
				minute = Number(part.value)
				break
		}
	}
	return Date.UTC(year, month - 1, day, hour, minute)
}

/** `tz`'s offset from UTC at `instant`, in milliseconds, minute precision. */
export function offsetAt(instant: number, tz: string): number {
	const floored = Math.floor(instant / MINUTE) * MINUTE
	return wallOf(floored, tz) - floored
}

/**
 * Every instant whose wall clock in `tz` reads `wall`.
 *
 * One instant normally, two in the hour a fall-back repeats (earliest first),
 * none in the hour a spring-forward skips.
 */
export function instantsForWall(wall: number, tz: string): number[] {
	const offsets = new Set<number>([
		offsetAt(wall - 26 * HOUR, tz),
		offsetAt(wall, tz),
		offsetAt(wall + 26 * HOUR, tz),
	])
	const found = new Set<number>()
	for (const offset of offsets) {
		const candidate = wall - offset
		if (wallOf(candidate, tz) === wall) found.add(candidate)
	}
	return [...found].sort((a, b) => a - b)
}

/**
 * The first instant whose wall clock is later than `wall`, for a `wall` that
 * falls inside a spring-forward gap: the moment the clocks jumped.
 */
export function firstInstantAfterGap(wall: number, tz: string): number {
	const a = offsetAt(wall - 26 * HOUR, tz)
	const b = offsetAt(wall + 26 * HOUR, tz)
	let lo = Math.floor((wall - Math.max(a, b)) / MINUTE)
	let hi = Math.ceil((wall - Math.min(a, b)) / MINUTE)
	// Smallest minute m in [lo, hi] with wallOf(m) > wall.
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2)
		if (wallOf(mid * MINUTE, tz) > wall) hi = mid
		else lo = mid + 1
	}
	return lo * MINUTE
}

/** Civil date parts of a wall value. */
export function civil(wall: number): {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	weekday: number
} {
	const d = new Date(wall)
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		weekday: d.getUTCDay(),
	}
}

/** `YYYY-MM-DD HH:MM` for an instant in `tz`. */
export function formatWall(instant: number, tz: string): string {
	const c = civil(wallOf(instant, tz))
	const p = (n: number) => String(n).padStart(2, '0')
	return `${c.year}-${p(c.month)}-${p(c.day)} ${p(c.hour)}:${p(c.minute)}`
}
