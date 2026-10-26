import { describe, expect, it } from 'vitest'

import {
	withQueuedRow,
	withStartedRow,
	withTakenOverRow,
	withoutQueuedRow,
} from './queued-calls.js'

type Row = { id: string; turnId?: string; queued?: true; startedAt: number; label: string }
const waiting = (id: string, label = id): Row => ({ id, queued: true, startedAt: 0, label })

describe('the row of a call waiting for its yes', () => {
	it('is added once', () => {
		const rows = withQueuedRow(withQueuedRow([], waiting('a')), waiting('a'))
		expect(rows).toHaveLength(1)
	})

	it('is taken away when the call is refused, but a running call keeps its row', () => {
		const rows: Row[] = [waiting('a'), { id: 'b', startedAt: 1, label: 'b' }]
		expect(withoutQueuedRow(rows, 'a').map((row) => row.id)).toEqual(['b'])
		expect(withoutQueuedRow(rows, 'b').map((row) => row.id)).toEqual(['a', 'b'])
	})

	it('becomes a running row, with its clock started, once approved', () => {
		const [row] = withStartedRow([waiting('a')], 'a', 500)
		expect(row).toEqual({ id: 'a', startedAt: 500, label: 'a' })
	})

	it('is taken over by the call starting, whether it still waits or was approved, never doubled', () => {
		const start = { id: 'a', startedAt: 9, label: 'started' }
		for (const existing of [waiting('a'), { id: 'a', startedAt: 1, label: 'a' }]) {
			const rows = withTakenOverRow([waiting('z'), existing, waiting('y')], start)
			expect(rows.map((row) => row.label)).toEqual(['z', 'started', 'y'])
		}
	})

	it('is added at the end when the call had no row, and a row of another turn is not taken over', () => {
		expect(
			withTakenOverRow([waiting('z')], { id: 'a', startedAt: 1, label: 'a' }).map((r) => r.id),
		).toEqual(['z', 'a'])
		const other: Row = { id: 'a', turnId: 't1', startedAt: 1, label: 'old' }
		const rows = withTakenOverRow([other], { id: 'a', turnId: 't2', startedAt: 2, label: 'new' })
		expect(rows.map((row) => row.label)).toEqual(['old', 'new'])
	})
})
