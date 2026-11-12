/**
 * Local days, from an injectable clock.
 *
 * The ledger keeps spend in 15-minute slots of UTC time, never in days: a day
 * depends on the person's zone, and the zone can change under the same file
 * (travel, a daylight-saving change). Every zone offset in use is a multiple
 * of 15 minutes, so a slot never straddles a local midnight, and the day of a
 * slot is looked up here when a report is made.
 */

/** Local days a report covers by default, and the most it will cover. */
export const DEFAULT_SPEND_DAYS = 30
export const MAX_SPEND_DAYS = 3660

export const SLOT_MS = 15 * 60_000

export interface SpendClock {
	/** Milliseconds since the epoch. */
	readonly nowMs: () => number
	/** An IANA zone name such as `Europe/Istanbul`. */
	readonly timeZone: string
}

export function systemClock(): SpendClock {
	const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
	return { nowMs: () => Date.now(), timeZone: zone || 'UTC' }
}

export function slotOf(ms: number): number {
	return Math.floor(ms / SLOT_MS)
}

/** `YYYY-MM-DD` of an instant in a zone. */
export function createDayKeyer(timeZone: string): (ms: number) => string {
	const format = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	})
	const cache = new Map<number, string>()
	return (ms) => {
		const slot = slotOf(ms)
		const hit = cache.get(slot)
		if (hit !== undefined) return hit
		let year = ''
		let month = ''
		let day = ''
		for (const part of format.formatToParts(new Date(slot * SLOT_MS))) {
			if (part.type === 'year') year = part.value
			else if (part.type === 'month') month = part.value
			else if (part.type === 'day') day = part.value
		}
		const key = `${year.padStart(4, '0')}-${month}-${day}`
		cache.set(slot, key)
		return key
	}
}

/** The calendar day `back` days before `day` (`YYYY-MM-DD`); calendar arithmetic, so a 23 or 25 hour day counts once. */
export function shiftDay(day: string, back: number): string {
	const [y, m, d] = day.split('-').map(Number) as [number, number, number]
	const shifted = new Date(Date.UTC(y, m - 1, d - back))
	return shifted.toISOString().slice(0, 10)
}
