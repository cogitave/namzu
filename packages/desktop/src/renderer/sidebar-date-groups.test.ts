import { beforeAll, expect, it } from 'vitest'
import type { ConversationView } from '../shared/protocol.js'
import {
	groupByDay,
	localDayStart,
	nextLocalMidnight,
	recentSections,
} from './sidebar-date-groups.js'

// A zone that changes its clocks, so the tests below hit a 25-hour and a 23-hour day.
beforeAll(() => {
	process.env.TZ = 'America/New_York'
	// Fail loudly if this runtime ignored the zone, rather than pass for the wrong reason.
	expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240)
})

const local = (y: number, m: number, d: number, h = 0, min = 0) =>
	new Date(y, m - 1, d, h, min).getTime()
const label = (start: number) =>
	new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const stamp = (row: number) => row
const names = (groups: { label: string }[]) => groups.map((group) => group.label)

it('puts today, yesterday, five dated days and everything older in their own groups', () => {
	const now = local(2026, 11, 10, 15)
	const rows = [
		local(2026, 11, 10, 9), // today
		local(2026, 11, 9, 23, 59), // yesterday
		local(2026, 11, 8, 12),
		local(2026, 11, 4, 0, 0), // the sixth day back: still dated
		local(2026, 11, 3, 23, 59), // the seventh day back: older
		local(2026, 8, 1),
	]
	const groups = groupByDay(rows, stamp, now, label)
	expect(names(groups)).toEqual(['Today', 'Yesterday', 'Nov 8', 'Nov 4', 'Older'])
	expect(groups.map((group) => group.rows.length)).toEqual([1, 1, 1, 1, 2])
})

it('hides groups with no rows and keeps the order rows came in', () => {
	const now = local(2026, 11, 10, 15)
	const groups = groupByDay(
		[3, 2, 1].map((hour) => local(2026, 11, 10, hour)),
		stamp,
		now,
		label,
	)
	expect(names(groups)).toEqual(['Today'])
	expect(groups[0]?.rows).toEqual([
		local(2026, 11, 10, 3),
		local(2026, 11, 10, 2),
		local(2026, 11, 10, 1),
	])
})

it('reads a time in the future as today and one it cannot read as older', () => {
	const now = local(2026, 11, 10, 15)
	const groups = groupByDay([local(2026, 11, 12), Number.NaN, 0], stamp, now, label)
	expect(names(groups)).toEqual(['Today', 'Older'])
	expect(groups[1]?.rows).toHaveLength(2)
})

it('starts yesterday at midnight on the day the clocks go back (a 25-hour day)', () => {
	// 2026-11-01 is 25 hours long in New York. Midnight to midnight, not 24 hours before now.
	const now = local(2026, 11, 2, 10)
	expect(localDayStart(now, -1)).toBe(local(2026, 11, 1, 0))
	expect(localDayStart(now) - localDayStart(now, -1)).toBe(25 * 3_600_000)
	const groups = groupByDay(
		[
			local(2026, 11, 1, 0, 30), // 30 minutes into that day, 24 h 30 min before 01:00 on the 2nd
			local(2026, 11, 1, 23, 59),
			local(2026, 10, 31, 23, 30),
		],
		stamp,
		now,
		label,
	)
	expect(names(groups)).toEqual(['Yesterday', 'Oct 31'])
	expect(groups[0]?.rows).toHaveLength(2)
})

it('starts yesterday at midnight on the day the clocks go forward (a 23-hour day)', () => {
	// 2026-03-08 is 23 hours long. Seen from the 9th, "yesterday" begins at its own midnight.
	const now = local(2026, 3, 9, 8)
	expect(localDayStart(now) - localDayStart(now, -1)).toBe(23 * 3_600_000)
	const groups = groupByDay([local(2026, 3, 8, 0, 0), local(2026, 3, 7, 23, 59)], stamp, now, label)
	expect(names(groups)).toEqual(['Yesterday', 'Mar 7'])
})

it('keeps the five dated days on the calendar across the change', () => {
	const now = local(2026, 11, 2, 10)
	const groups = groupByDay([local(2026, 10, 29, 12), local(2026, 10, 28, 12)], stamp, now, label)
	expect(names(groups)).toEqual(['Oct 29', 'Oct 28'])
})

it('names the moment the groups next change as the next local midnight', () => {
	expect(nextLocalMidnight(local(2026, 11, 1, 0, 30))).toBe(local(2026, 11, 2, 0))
	expect(nextLocalMidnight(local(2026, 11, 1, 0, 30)) - local(2026, 11, 1, 0, 30)).toBe(
		24.5 * 3_600_000,
	)
	expect(nextLocalMidnight(local(2026, 3, 8, 12))).toBe(local(2026, 3, 9, 0))
})

it('gives a day-change timer the real wait on the 23-hour day', () => {
	// From 00:30 on the day the clocks go forward there are 22.5 hours left, not 23.5.
	expect(nextLocalMidnight(local(2026, 3, 8, 0, 30)) - local(2026, 3, 8, 0, 30)).toBe(
		22.5 * 3_600_000,
	)
})

function view(id: string, updatedAt: number, pinned?: true): ConversationView {
	return {
		id,
		projectId: 'p',
		title: id,
		updatedAt: new Date(updatedAt).toISOString(),
		...(pinned ? { pinned } : {}),
	}
}

it('lists pinned conversations apart from the days, whatever day they were last touched', () => {
	const now = local(2026, 11, 10, 15)
	const sections = recentSections(
		[
			view('old-pin', local(2026, 1, 1), true),
			view('a', local(2026, 11, 10, 9)),
			view('b', local(2026, 11, 9, 9)),
		],
		now,
	)
	expect(sections.map((section) => [section.key, section.rows.map((row) => row.id)])).toEqual([
		['pinned', ['old-pin']],
		['today', ['a']],
		['yesterday', ['b']],
	])
})

it('has no Pinned heading when nothing is pinned', () => {
	expect(
		recentSections([view('a', local(2026, 11, 10, 9))], local(2026, 11, 10, 15)).map(
			(section) => section.key,
		),
	).toEqual(['today'])
})
