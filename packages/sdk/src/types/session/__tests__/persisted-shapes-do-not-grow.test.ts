import { describe, expect, it } from 'vitest'

import { CheckpointSchema } from '../checkpoint.js'
import {
	ChildSessionEndedRecordSchema,
	TurnCompletedRecordSchema,
	TurnFailedRecordSchema,
	TurnSettlementSchema,
} from '../records.js'

/**
 * A release that validates one of these strictly refuses any session log or
 * checkpoint that carries a key it does not know, and a person's Desktop app
 * and global CLI read the same session folder at different versions. So a
 * shape that already shipped does not gain a field: new data goes in a new,
 * ignorable record type (see the "Records from a newer writer" section of
 * docs/sdk/session-log.md), which an older reader skips.
 *
 * The key lists are the ones the shapes had before the turn outcome record.
 * Adding a key here is the thing this test exists to make a deliberate act.
 */

const sorted = (keys: readonly string[]) => [...keys].sort()

describe('a persisted shape that older readers validate strictly', () => {
	it('keeps the settlement of turn_completed and turn_failed as it was', () => {
		const expected = [
			'abandonedJobIds',
			'abandonedTaskIds',
			'cost',
			'durationMs',
			'iterations',
			'resultMessageId',
			'resultSource',
			'servingProvider',
			'status',
			'structuredOutput',
			'usage',
		]
		expect(sorted(Object.keys(TurnSettlementSchema.shape))).toEqual(expected)
		expect(sorted(Object.keys(TurnCompletedRecordSchema.shape.settlement.shape))).toEqual(expected)
		expect(sorted(Object.keys(TurnFailedRecordSchema.shape.settlement.shape))).toEqual(expected)
	})

	it('keeps child_session_ended as it was', () => {
		expect(sorted(Object.keys(ChildSessionEndedRecordSchema.shape))).toEqual([
			'childSessionId',
			'cost',
			'gen',
			'id',
			'prev',
			'prevText',
			'resultMessageId',
			'seq',
			'sessionId',
			'status',
			'stopReason',
			'ts',
			'turnId',
			'type',
			'usage',
			'v',
		])
	})

	it('keeps the checkpoint document as it was', () => {
		expect(sorted(Object.keys(CheckpointSchema.shape))).toEqual([
			'budget',
			'checkpointId',
			'costInfo',
			'createdAt',
			'guards',
			'iteration',
			'kind',
			'latestUserMessageId',
			'review',
			'sessionId',
			'throughSeq',
			'throughSha256',
			'tokenUsage',
			'trace',
			'turnCreatedAt',
			'turnId',
			'v',
			'workingState',
		])
	})
})
