import { describe, expect, it } from 'vitest'
import type { CheckpointId } from '../../../types/ids/index.js'
import { generateCheckpointId } from '../../../utils/id.js'
import {
	type PrunableSessionCheckpoint,
	compareCheckpoints,
	selectSessionCheckpointsToPrune,
} from '../prune.js'

function at(createdAt: string, checkpointId = generateCheckpointId()): PrunableSessionCheckpoint {
	return { checkpointId, createdAt }
}

describe('selectSessionCheckpointsToPrune', () => {
	it('selects the oldest beyond keepLast, whatever order they arrive in', () => {
		const a = at('2026-09-21T10:00:00.000Z')
		const b = at('2026-09-21T10:00:01.000Z')
		const c = at('2026-09-21T10:00:02.000Z')
		expect(selectSessionCheckpointsToPrune([c, a, b], 1)).toEqual([a.checkpointId, b.checkpointId])
		expect(selectSessionCheckpointsToPrune([c, a, b], 0)).toEqual([
			a.checkpointId,
			b.checkpointId,
			c.checkpointId,
		])
	})

	it('selects nothing when keepLast already covers every checkpoint', () => {
		const list = [at('2026-09-21T10:00:00.000Z'), at('2026-09-21T10:00:01.000Z')]
		expect(selectSessionCheckpointsToPrune(list, 2)).toEqual([])
		expect(selectSessionCheckpointsToPrune(list, 10)).toEqual([])
		expect(selectSessionCheckpointsToPrune([], 0)).toEqual([])
	})

	it('skips a protected checkpoint among the candidates rather than counting it', () => {
		const a = at('2026-09-21T10:00:00.000Z')
		const b = at('2026-09-21T10:00:01.000Z')
		const c = at('2026-09-21T10:00:02.000Z')
		const d = at('2026-09-21T10:00:03.000Z')
		expect(selectSessionCheckpointsToPrune([a, b, c, d], 1, new Set([b.checkpointId]))).toEqual([
			a.checkpointId,
			c.checkpointId,
		])
	})

	it('breaks a createdAt tie by id, so the order is total', () => {
		const time = '2026-09-21T10:00:00.000Z'
		const low = at(time, '00000000-0000-7000-8000-000000000001' as CheckpointId)
		const high = at(time, '00000000-0000-7000-8000-000000000002' as CheckpointId)
		expect(selectSessionCheckpointsToPrune([high, low], 1)).toEqual([low.checkpointId])
		expect(compareCheckpoints(low, low)).toBe(0)
		expect(compareCheckpoints(high, low)).toBe(1)
		expect(compareCheckpoints(low, high)).toBe(-1)
	})

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses keepLast %s', (keepLast) => {
		expect(() => selectSessionCheckpointsToPrune([], keepLast)).toThrow(RangeError)
	})
})
