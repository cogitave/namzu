import type { ConversationView } from '../shared/protocol.js'

/**
 * Day buckets for the Recents list. Boundaries are local midnights built from the calendar date,
 * never by subtracting 24 hours, so a day that is 23 or 25 hours long (a clock change) still
 * starts and ends at midnight.
 */
export interface DayGroup<T> {
	/** Stable across renders, so a heading keeps its place while rows move. */
	key: string
	label: string
	rows: T[]
}

/** The start of the local day `offset` days from the day `now` falls on (negative is earlier). */
export function localDayStart(now: number, offset = 0): number {
	const date = new Date(now)
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime()
}

/** The first moment of the next local day: when the buckets change. */
export function nextLocalMidnight(now: number): number {
	return localDayStart(now, 1)
}

/** Today, Yesterday, the five days before them by date, then everything older. */
export function groupByDay<T>(
	rows: readonly T[],
	stamp: (row: T) => number,
	now: number,
	formatDate: (dayStart: number) => string = defaultDateLabel,
): DayGroup<T>[] {
	const starts = Array.from({ length: 7 }, (_, index) => localDayStart(now, -index))
	const groups: DayGroup<T>[] = starts.map((start, index) => ({
		key: index === 0 ? 'today' : index === 1 ? 'yesterday' : `day-${start}`,
		label: index === 0 ? 'Today' : index === 1 ? 'Yesterday' : formatDate(start),
		rows: [],
	}))
	const older: DayGroup<T> = { key: 'older', label: 'Older', rows: [] }
	for (const row of rows) {
		const time = stamp(row)
		// A time in the future (a clock that moved back) belongs to today; one we cannot read to Older.
		const index =
			Number.isFinite(time) && time > 0 ? starts.findIndex((start) => time >= start) : -1
		if (index === -1) older.rows.push(row)
		else groups[index]?.rows.push(row)
	}
	return [...groups, older].filter((group) => group.rows.length > 0)
}

function defaultDateLabel(dayStart: number): string {
	return new Date(dayStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Pinned conversations in their own group, then the rest by the day they were last touched. */
export function recentSections(
	rows: readonly ConversationView[],
	now: number,
): { key: string; label: string; rows: ConversationView[] }[] {
	const pinned = rows.filter((item) => item.pinned)
	const days = groupByDay(
		rows.filter((item) => !item.pinned),
		(item) => Date.parse(item.updatedAt),
		now,
	)
	return [...(pinned.length > 0 ? [{ key: 'pinned', label: 'Pinned', rows: pinned }] : []), ...days]
}
