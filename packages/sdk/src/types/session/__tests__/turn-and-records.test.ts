import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'

import { fixtureId } from '../../../test-support/ids.js'
import type { AuditOutcome } from '../audit.js'
import type { CancelCause } from '../cancel-cause.js'
import {
	CHECKPOINT_DOCUMENT_VERSION,
	type Checkpoint,
	CheckpointDocumentError,
	parseCheckpoint,
} from '../checkpoint.js'
import type { PersistedSessionEventType, SessionEvent, SessionEventType } from '../events.js'
import {
	type ExternalRefSchema,
	type MessageRecord,
	type OriginSchema,
	type SessionEventRecord,
	type SessionRecord,
	SessionRecordSchema,
	type SessionRecordType,
	type SessionStartedRecord,
	type TurnBoundSessionEventType,
	type TurnSettlementSchema,
} from '../records.js'
import type { StopReason } from '../stop-reason.js'
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

describe('a record between turns and the audit trail', () => {
	const pointer = { seq: 1, offset: 0, length: 10, sha256: 'a'.repeat(64) }
	const envelope = (type: string, extra: Record<string, unknown>) => ({
		v: 1,
		type,
		id: fixtureId.record('between'),
		sessionId,
		seq: 2,
		ts: '2026-09-21T09:00:00.000Z',
		prev: pointer,
		gen: 1,
		...extra,
	})
	const audit = (extra: Record<string, unknown> = {}) =>
		envelope('audit', {
			turnId: activeTurnId,
			auditId: 'audit-1',
			actor: { kind: 'agent', agentId: 'worker', tenantId: fixtureId.tenant('audit') },
			action: 'tool_call',
			outcome: 'refused',
			reason: 'Blocked by the authorization gate.',
			...extra,
		})

	it('holds every field the audit trail records today', () => {
		const full = audit({
			persona: 'reviewer',
			tool: 'bash',
			resource: 'pii-guardrail',
			cost: { totalCost: 0.01, cacheDiscount: 0, unpricedTokens: 0 },
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
		})
		expect(SessionRecordSchema.parse(full)).toEqual(full)
		// Outside a turn, as a session-level audit entry is.
		const { turnId: _turnId, ...between } = audit() as Record<string, unknown>
		expect(SessionRecordSchema.safeParse(between).success).toBe(true)
	})

	it('accepts only the four audit outcomes, and a trace link only whole', () => {
		for (const outcome of ['success', 'failure', 'refused', 'approved']) {
			expect(SessionRecordSchema.safeParse(audit({ outcome })).success, outcome).toBe(true)
		}
		expect(SessionRecordSchema.safeParse(audit({ outcome: 'allowed' })).success).toBe(false)
		const halfTrace = SessionRecordSchema.safeParse(audit({ traceId: 'a'.repeat(32) }))
		expect(halfTrace.success).toBe(false)
		expect(JSON.stringify(halfTrace.error?.issues)).toMatch(/traceId and spanId together/)
		expect(SessionRecordSchema.safeParse(audit({ spanId: 'b'.repeat(16) })).success).toBe(false)
	})

	it.each([
		[
			'child_session_ended',
			{
				status: 'completed',
				usage: {
					promptTokens: 1,
					completionTokens: 1,
					totalTokens: 2,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
			},
		],
		['child_session_idled', {}],
		['child_session_messaged', { messageId: fixtureId.message('child') }],
	] as const)('records %s from a child that outlived its turn, with no turnId', (type, payload) => {
		const record = envelope(type, { childSessionId: fixtureId.session('child'), ...payload })
		expect(SessionRecordSchema.parse(record)).toEqual(record)
		expect(SessionRecordSchema.safeParse({ ...record, turnId: activeTurnId }).success).toBe(true)
	})

	it('still requires the turn on the spawn', () => {
		const spawned = envelope('child_session_spawned', {
			childSessionId: fixtureId.session('child'),
			toolCallId: 'toolu_1',
			kind: 'agent_spawn',
			description: 'd',
			path: 'subagents/x.jsonl',
		})
		expect(SessionRecordSchema.safeParse(spawned).success).toBe(false)
		expect(SessionRecordSchema.safeParse({ ...spawned, turnId: activeTurnId }).success).toBe(true)
	})
})

describe('the TypeScript record view is as strong as the schema', () => {
	/** The persisted event types whose live event requires `turnId`. */
	type RequiresTurn<T extends PersistedSessionEventType = PersistedSessionEventType> =
		T extends PersistedSessionEventType
			? undefined extends Extract<SessionEvent, { type: T }>['turnId']
				? never
				: T
			: never

	it('lists exactly the event types whose live event requires a turn', () => {
		expectTypeOf<TurnBoundSessionEventType>().toEqualTypeOf<RequiresTurn>()
	})

	it('gives a turn-bound record a non-optional turnId, and leaves the rest optional', () => {
		expectTypeOf<Extract<SessionRecord, { type: 'turn_completed' }>['turnId']>().toEqualTypeOf<
			typeof activeTurnId
		>()
		expectTypeOf<Extract<SessionRecord, { type: 'tool_completed' }>['turnId']>().toEqualTypeOf<
			typeof activeTurnId
		>()
		expectTypeOf<
			Extract<SessionRecord, { type: 'child_session_spawned' }>['turnId']
		>().toEqualTypeOf<typeof activeTurnId>()
		expectTypeOf<
			Extract<SessionRecord, { type: 'background_job_exited' }>['turnId']
		>().toEqualTypeOf<typeof activeTurnId | undefined>()
		expectTypeOf<Extract<SessionRecord, { type: 'child_session_idled' }>['turnId']>().toEqualTypeOf<
			typeof activeTurnId | undefined
		>()
		expectTypeOf<Extract<SessionRecord, { type: 'child_session_ended' }>['turnId']>().toEqualTypeOf<
			typeof activeTurnId | undefined
		>()
		expectTypeOf<
			Extract<SessionRecord, { type: 'audit' }>['outcome']
		>().toEqualTypeOf<AuditOutcome>()
	})
})

describe('cross-field record rules', () => {
	const pointer = { seq: 9, offset: 900, length: 10, sha256: 'a'.repeat(64) }
	const inTurn = (type: string, extra: Record<string, unknown>) => ({
		v: 1,
		type,
		id: fixtureId.record('rules'),
		sessionId,
		turnId: activeTurnId,
		seq: 10,
		ts: '2026-09-21T09:00:00.000Z',
		prev: pointer,
		gen: 1,
		...extra,
	})
	const settlement = (status: string) => ({
		status,
		iterations: 1,
		usage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		durationMs: 5,
		resultSource: 'model',
		abandonedTaskIds: [],
		abandonedJobIds: [],
	})
	const accepts = (record: unknown) => SessionRecordSchema.safeParse(record).success

	it.each([
		['turn_completed', { result: 'done' }, ['completed', 'cancelled']],
		['turn_failed', { error: 'boom' }, ['failed']],
	] as const)('lets %s settle only its own verdict', (type, payload, allowed) => {
		for (const status of ['idle', 'pending', 'running', 'completed', 'failed', 'cancelled']) {
			const record = inTurn(type, { ...payload, settlement: settlement(status) })
			expect(accepts(record), `${type} with ${status}`).toBe(
				(allowed as readonly string[]).includes(status),
			)
		}
	})

	it("holds a message record's role to its content's role", () => {
		const message = (role: string, contentRole: string) =>
			inTurn('message', {
				messageId: fixtureId.message('rules'),
				role,
				content: { role: contentRole, content: 'hi' },
			})
		expect(accepts(message('user', 'user'))).toBe(true)
		const mismatched = SessionRecordSchema.safeParse(message('assistant', 'user'))
		expect(mismatched.success).toBe(false)
		expect(JSON.stringify(mismatched.error?.issues)).toMatch(
			/role \(assistant\) is its content's role \(user\)/,
		)
	})

	it('keeps a checkpoint behind its own record', () => {
		const written = (throughSeq: number) =>
			inTurn('checkpoint_written', {
				checkpointId: fixtureId.checkpoint('rules'),
				iteration: 1,
				throughSeq,
				throughSha256: 'b'.repeat(64),
				path: 'checkpoints/x.json',
				docSha256: 'c'.repeat(64),
			})
		expect(accepts(written(9))).toBe(true)
		expect(accepts(written(10))).toBe(false)
		expect(accepts(written(11))).toBe(false)
	})

	it('replaces only an ascending range of earlier records', () => {
		const compaction = (replacesSeqRange: [number, number]) =>
			inTurn('compaction', {
				compactionId: 'compaction-1',
				strategy: 'summary',
				trigger: 'auto',
				replacesSeqRange,
				summary: [],
				keptMessageIds: [],
				tokensBefore: 10,
				tokensAfter: 2,
			})
		expect(accepts(compaction([2, 9]))).toBe(true)
		expect(accepts(compaction([4, 4]))).toBe(true)
		expect(accepts(compaction([9, 2]))).toBe(false)
		expect(accepts(compaction([2, 10]))).toBe(false)
		expect(accepts(compaction([2, 12]))).toBe(false)
	})
})
