import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'

import { fixtureId } from '../../../test-support/ids.js'
import type { CancelCause } from '../../run/cancel-cause.js'
import type { StopReason } from '../../run/stop-reason.js'
import {
	CHECKPOINT_DOCUMENT_VERSION,
	type Checkpoint,
	CheckpointDocumentError,
	parseCheckpoint,
} from '../checkpoint.js'
import type { SessionEvent, SessionEventType } from '../events.js'
import type {
	ExternalRefSchema,
	MessageRecord,
	OriginSchema,
	SessionEventRecord,
	SessionRecord,
	SessionRecordType,
	SessionStartedRecord,
	TurnSettlementSchema,
} from '../records.js'
import type { SubSessionKind } from '../sub-session.js'
import {
	type ExternalRef,
	type Origin,
	TurnInProgressError,
	type TurnSettlement,
	isTurnInProgressError,
} from '../turn.js'

const sessionId = fixtureId.session('turn-test')
const activeTurnId = fixtureId.turn('turn-test')

describe('TurnInProgressError', () => {
	it.each([
		['running', /Wait for it to end/],
		['paused', /resumeSession .* abandonTurn/],
		['interrupted', /abandonInterrupted/],
	] as const)('names the session, the active turn and the way out when %s', (state, remedy) => {
		const error = new TurnInProgressError({ sessionId, activeTurnId, state })
		expect(error.name).toBe('TurnInProgressError')
		expect(error.state).toBe(state)
		expect(error.message).toContain(sessionId)
		expect(error.message).toContain(activeTurnId)
		expect(error.message).toMatch(remedy)
		expect(isTurnInProgressError(error)).toBe(true)
	})

	it('is recognised across package copies by shape, and nothing else is', () => {
		const foreign = Object.assign(new Error('x'), {
			name: 'TurnInProgressError',
			sessionId,
			activeTurnId,
			state: 'paused',
		})
		expect(isTurnInProgressError(foreign)).toBe(true)
		expect(isTurnInProgressError({ ...foreign, state: 'done' })).toBe(false)
		expect(isTurnInProgressError(new Error('TurnInProgressError'))).toBe(false)
		expect(isTurnInProgressError(null)).toBe(false)
		expect(isTurnInProgressError('TurnInProgressError')).toBe(false)
	})
})

describe('checkpoint documents', () => {
	const checkpoint = (): Checkpoint => ({
		v: CHECKPOINT_DOCUMENT_VERSION,
		kind: 'checkpoint',
		checkpointId: fixtureId.checkpoint('c'),
		sessionId,
		turnId: activeTurnId,
		iteration: 2,
		throughSeq: 14,
		throughSha256: 'c'.repeat(64),
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		budget: {
			binding: { rootSessionId: sessionId, rootTurnId: activeTurnId, accountId: 'account-1' },
			accountId: 'account-1',
		},
		guards: { iteration: 2, elapsedMs: 900 },
		review: { structuredAttempts: 0, answerAttempts: 1, nativeStructuredAttempts: 0 },
		turnCreatedAt: '2026-09-21T09:00:00.000Z',
		createdAt: '2026-09-21T09:00:05.000Z',
	})

	it('round-trips a valid document', () => {
		const value = checkpoint()
		expect(parseCheckpoint(JSON.parse(JSON.stringify(value)))).toEqual(value)
	})

	it('refuses a run-era checkpoint by name', () => {
		expect(() => parseCheckpoint({ kind: 'run-checkpoint', id: 'x' })).toThrow(
			/Checkpoints from earlier releases are not read/,
		)
	})

	it('refuses another version, and inline messages', () => {
		expect(() => parseCheckpoint({ ...checkpoint(), v: 2 })).toThrow(
			/Unsupported checkpoint version 2/,
		)
		expect(() => parseCheckpoint({ ...checkpoint(), messages: [] })).toThrow(
			CheckpointDocumentError,
		)
		expect(() => parseCheckpoint('not an object')).toThrow(CheckpointDocumentError)
	})
})

describe('the record types agree with the runtime types they carry', () => {
	it('matches payload shapes the rest of the SDK uses', () => {
		expectTypeOf<z.infer<typeof OriginSchema>>().toMatchTypeOf<Origin>()
		expectTypeOf<z.infer<typeof ExternalRefSchema>>().toMatchTypeOf<ExternalRef>()
		expectTypeOf<z.infer<typeof TurnSettlementSchema>['status']>().toEqualTypeOf<
			TurnSettlement['status']
		>()
		expectTypeOf<z.infer<typeof TurnSettlementSchema>['resultSource']>().toEqualTypeOf<
			TurnSettlement['resultSource']
		>()
		expectTypeOf<
			NonNullable<SessionStartedRecord['parent']>['kind']
		>().toEqualTypeOf<SubSessionKind>()
		expectTypeOf<
			NonNullable<Extract<SessionEventRecord, { type: 'turn_completed' }>['stopReason']>
		>().toEqualTypeOf<StopReason>()
		expectTypeOf<
			NonNullable<Extract<SessionEventRecord, { type: 'turn_completed' }>['cancelCause']>
		>().toEqualTypeOf<CancelCause>()
	})

	it('keeps branded ids branded', () => {
		expectTypeOf<SessionStartedRecord['sessionId']>().toEqualTypeOf<typeof sessionId>()
		expectTypeOf<MessageRecord['turnId']>().toEqualTypeOf<typeof activeTurnId>()
	})

	it('makes a record of every persisted event without its live-only fields', () => {
		type Completed = Extract<SessionRecord, { type: 'turn_completed' }>
		expectTypeOf<Completed>().toHaveProperty('settlement')
		expectTypeOf<Completed>().toHaveProperty('seq')
		expectTypeOf<Completed>().not.toHaveProperty('lineage')
		expectTypeOf<Extract<SessionRecordType, 'text_delta'>>().toBeNever()
		expectTypeOf<Extract<SessionRecordType, 'compaction'>>().toEqualTypeOf<'compaction'>()
		expectTypeOf<Extract<SessionEventType, 'compaction'>>().toBeNever()
	})

	it('names the session on every event and requires the turn where it must be inside one', () => {
		expectTypeOf<SessionEvent['sessionId']>().toEqualTypeOf<typeof sessionId>()
		expectTypeOf<Extract<SessionEvent, { type: 'turn_started' }>['turnId']>().toEqualTypeOf<
			typeof activeTurnId
		>()
		expectTypeOf<
			Extract<SessionEvent, { type: 'background_job_exited' }>['turnId']
		>().toEqualTypeOf<typeof activeTurnId | undefined>()
	})
})
