import { describe, expect, it } from 'vitest'
import { changesSinceConfirmed, describeChanges } from '../changes.js'
import type { ScheduleHistoryRecord } from '../types.js'

const job = (action: 'created' | 'edited' | 'confirmed', by: string, changes?: string[]) =>
	({
		v: 1,
		kind: 'job',
		at: '2026-09-23T00:00:00Z',
		action,
		by,
		...(changes ? { changes } : {}),
	}) as ScheduleHistoryRecord

describe('changes since a job was confirmed', () => {
	it('lists removed then added lines, ignoring indentation', () => {
		expect(describeChanges(['a', '  b'], ['b', 'c'])).toEqual(['- a', '+ c'])
	})

	it('collects edits saved without a terminal since the last confirmation', () => {
		expect(
			changesSinceConfirmed([
				job('created', 'cli-tty'),
				job('edited', 'cli-noninteractive', ['+ one']),
				job('confirmed', 'cli-tty'),
				job('edited', 'cli-noninteractive', ['+ two']),
				job('edited', 'cli-noninteractive', ['- three']),
			]),
		).toEqual(['+ two', '- three'])
		expect(
			changesSinceConfirmed([job('edited', 'cli-noninteractive', ['+ x']), job('edited', 'tui')]),
		).toEqual([])
	})
})
