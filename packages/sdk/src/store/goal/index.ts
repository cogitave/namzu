import { join } from 'node:path'

import { TenantIsolationError } from '../../session/errors.js'
import type {
	GoalBlockReason,
	GoalConfirmedBy,
	GoalGuards,
	GoalPhase,
	GoalRef,
	GoalRoundAuthority,
	GoalRoundOutcome,
	SessionGoal,
} from '../../types/goal/index.js'
import type { GoalId, SessionId, TenantId } from '../../types/ids/index.js'
import type { SessionStore } from '../../types/session/store.js'
import { asGoalId, asSessionId, generateGoalId } from '../../utils/id.js'
import {
	DiskRevisionRecordStore,
	type RevisionMutation,
	type RevisionedRecordLocation,
	revisionFileSegment,
} from '../kv/revision-record-store.js'
import { defineSchema } from '../schema.js'

/** Current source-backed limit for a human goal objective. */
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000

/** Source-aligned default; hosts may choose a smaller positive finite cap. */
export const DEFAULT_MAX_GOAL_ROUNDS = 256

/**
 * Automatic turns in a row without progress, or ending on the same failure,
 * after which a host that applies the stop rules blocks the goal. Three: a
 * first empty turn is normal (the model looked around), a second can be a
 * check that needed a rerun, a third is a loop.
 */
export const DEFAULT_GOAL_STALL_ROUNDS = 3

/** Admitted rounds between check-in pauses that a host applying them may choose. */
export const DEFAULT_GOAL_CHECK_IN_ROUNDS = 50

export interface CreateSessionGoalParams {
	readonly sessionId: SessionId
	readonly objective: string
	readonly maxGoalRounds?: number
	/** Stop rules for this goal; absent fields are not applied. */
	readonly guards?: GoalGuards
	/** Set only when this goal chooses; absent leaves the choice to the host's setting. */
	readonly confirmedBy?: GoalConfirmedBy
}

export interface EditSessionGoalParams {
	readonly objective: string
}

export interface SessionGoalStore {
	getGoal(sessionId: SessionId, tenantId: TenantId): Promise<SessionGoal | null>
	createGoal(params: CreateSessionGoalParams, tenantId: TenantId): Promise<SessionGoal>
	editGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		changes: EditSessionGoalParams,
	): Promise<SessionGoal>
	pauseGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal>
	resumeGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		options?: ResumeSessionGoalOptions,
	): Promise<SessionGoal>
	/** Durably reserve one automatic round before any provider work begins. */
	admitRound(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<GoalRoundAuthority>
	completeGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal>
	blockGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		reason: GoalBlockReason,
	): Promise<SessionGoal>
	clearGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<void>
	/**
	 * Write down what one finished automatic turn did: what it spent, whether it
	 * moved the work, and the failure it ended on. The stop rules read these
	 * counts, so a goal that did nothing for `stallRounds` turns in a row, or
	 * ended on the same failure that many times, is blocked here. Optional so a
	 * store written before it existed still satisfies the interface; without it a
	 * host's goals are never stopped by those rules. Returns `null` when the
	 * session has no goal of that id.
	 */
	recordRound?(
		sessionId: SessionId,
		tenantId: TenantId,
		goalId: GoalId,
		outcome: GoalRoundOutcome,
	): Promise<SessionGoal | null>
}

/** What a resume may raise so that a goal stopped by a limit can go on. */
export interface ResumeSessionGoalOptions {
	/** Replaces the round cap when larger than the current one. */
	readonly maxGoalRounds?: number
	/** Replaces the token budget when larger than the current one. */
	readonly tokenBudget?: number
	/**
	 * Stop rules to fill in for a goal that has none of its own, such as one saved
	 * before they existed. A rule the goal already has is kept.
	 */
	readonly guards?: GoalGuards
}

/** What a goal has cost so far, as a dollar amount. */
export function goalCostText(goal: Pick<SessionGoal, 'costUsd'>): string {
	const cost = goal.costUsd ?? 0
	return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

/** What a goal has tokens-spent so far, as a number with separators. */
export function goalTokensText(goal: Pick<SessionGoal, 'tokensUsed'>): string {
	return (goal.tokensUsed ?? 0).toLocaleString('en-US')
}

/** The sentence that says what a goal has spent: automatic turns, tokens and cost. */
export function goalUsageSentence(goal: SessionGoal): string {
	const rounds = goal.roundsAdmitted
	return `${rounds} automatic turn${rounds === 1 ? '' : 's'}, ${goalTokensText(goal)} tokens, ${goalCostText(goal)}`
}

/** A mutation was based on a goal revision that is no longer current. */
export class StaleGoalError extends Error {
	readonly details: {
		readonly sessionId: SessionId
		readonly expectedRevision: number
		readonly actualRevision: number
	}

	constructor(details: StaleGoalError['details']) {
		super(
			`Stale goal for ${details.sessionId}: expected revision=${details.expectedRevision}, actual=${details.actualRevision}.`,
		)
		this.name = 'StaleGoalError'
		this.details = details
	}
}

/** A session already has a goal that has not completed or been cleared. */
export class GoalExistsError extends Error {
	constructor(readonly goal: SessionGoal) {
		super(`Session ${goal.sessionId} already has an ${goal.phase} goal.`)
		this.name = 'GoalExistsError'
	}
}

/** A goal operation was requested for a session with no current goal. */
export class GoalNotFoundError extends Error {
	constructor(readonly sessionId: SessionId) {
		super(`Session ${sessionId} has no current goal.`)
		this.name = 'GoalNotFoundError'
	}
}

/** A goal transition is invalid from its current durable phase. */
export class GoalTransitionError extends Error {
	constructor(
		readonly phase: GoalPhase,
		readonly operation: string,
	) {
		super(`Cannot ${operation} a goal whose phase is ${phase}.`)
		this.name = 'GoalTransitionError'
	}
}

/** Goal storage refuses ids that do not name a live tenant-owned Session. */
export class GoalSessionNotFoundError extends Error {
	constructor(readonly sessionId: SessionId) {
		super(`Cannot use a goal for ${sessionId}: that session does not exist.`)
		this.name = 'GoalSessionNotFoundError'
	}
}

/** Admission reached its finite cap after durably blocking the goal. */
export class GoalRoundLimitError extends Error {
	constructor(readonly goal: SessionGoal) {
		super(`Goal ${goal.id} has admitted all ${goal.maxGoalRounds} automatic rounds.`)
		this.name = 'GoalRoundLimitError'
	}
}

/** Admission paused the goal for a check-in instead of starting another round. */
export class GoalCheckInError extends Error {
	constructor(readonly goal: SessionGoal) {
		super(`Goal ${goal.id} paused for a check-in after ${goal.roundsAdmitted} automatic rounds.`)
		this.name = 'GoalCheckInError'
	}
}

/** Admission blocked the goal because its token budget was spent and its last round given. */
export class GoalBudgetLimitError extends Error {
	constructor(readonly goal: SessionGoal) {
		super(`Goal ${goal.id} reached its token budget.`)
		this.name = 'GoalBudgetLimitError'
	}
}

type AdmitOutcome =
	| { readonly kind: 'admitted'; readonly authority: GoalRoundAuthority }
	| { readonly kind: 'exhausted'; readonly goal: SessionGoal }
	| { readonly kind: 'check-in'; readonly goal: SessionGoal }

interface SessionGoalRecord {
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	/** Storage sequence survives clear and fresh goal identities. */
	readonly storageRevision: number
	readonly goal: SessionGoal | null
	readonly updatedAt: number
}

const SCHEMA = defineSchema({
	kind: 'session-goal',
	current: 2,
	migrations: {
		1: (record) => {
			const goal = record.goal
			if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) return record
			return {
				...record,
				goal: {
					...goal,
					maxGoalRounds: DEFAULT_MAX_GOAL_ROUNDS,
					roundsAdmitted: 0,
				},
			}
		},
	},
})
const revisionRecords = new DiskRevisionRecordStore<SessionGoalRecord>(
	SCHEMA,
	'session goal store',
	(record) => record.storageRevision,
)

interface GoalBackend {
	readonly read: (sessionId: SessionId) => Promise<SessionGoalRecord | null>
	readonly transact: <R>(
		sessionId: SessionId,
		mutate: (current: SessionGoalRecord | null) => RevisionMutation<SessionGoalRecord, R>,
	) => Promise<R>
}

const backends = new WeakMap<object, GoalBackend>()

function backendFor(store: object): GoalBackend {
	const backend = backends.get(store)
	if (!backend) throw new Error('Session goal store backend was not initialized.')
	return backend
}

function validSessionId(value: SessionId): SessionId {
	if (typeof value !== 'string') throw new TypeError('sessionId must be a string.')
	return asSessionId(value)
}

function validRef(ref: GoalRef): GoalRef {
	if (typeof ref.id !== 'string') throw new TypeError('goal id must be a string.')
	const id = asGoalId(ref.id)
	if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) {
		throw new TypeError(`goal revision must be a positive safe integer, got ${ref.revision}.`)
	}
	return { id, revision: ref.revision }
}

function objective(value: string): string {
	if (typeof value !== 'string') throw new TypeError('goal objective must be a string.')
	const trimmed = value.trim()
	if (trimmed.length === 0) throw new TypeError('goal objective must not be empty.')
	if ([...trimmed].length > MAX_GOAL_OBJECTIVE_CHARS) {
		throw new TypeError(`goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`)
	}
	return trimmed
}

function maxGoalRounds(value: number | undefined): number {
	const resolved = value ?? DEFAULT_MAX_GOAL_ROUNDS
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new TypeError(`maxGoalRounds must be a positive safe integer, got ${resolved}.`)
	}
	return resolved
}

function guardNumber(name: string, value: number | undefined, minimum: number): number | undefined {
	if (value === undefined) return undefined
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new TypeError(`${name} must be a safe integer of at least ${minimum}, got ${value}.`)
	}
	return value
}

function goalGuards(value: GoalGuards | undefined): GoalGuards | undefined {
	if (value === undefined) return undefined
	const stallRounds = guardNumber('stallRounds', value.stallRounds, 1)
	const checkInEvery = guardNumber('checkInEvery', value.checkInEvery, 0)
	const tokenBudget = guardNumber('tokenBudget', value.tokenBudget, 1)
	const guards: GoalGuards = {
		...(stallRounds !== undefined ? { stallRounds } : {}),
		...(checkInEvery !== undefined ? { checkInEvery } : {}),
		...(tokenBudget !== undefined ? { tokenBudget } : {}),
	}
	return Object.keys(guards).length > 0 ? guards : undefined
}

function blockReason(value: GoalBlockReason): GoalBlockReason {
	if (
		typeof value?.code !== 'string' ||
		!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.code) ||
		typeof value?.message !== 'string' ||
		value.message.trim().length === 0
	) {
		throw new TypeError(
			'goal block reason requires a lower-kebab-case code and a non-empty message.',
		)
	}
	return { code: value.code, message: value.message.trim() }
}

function assertTenant(record: SessionGoalRecord, tenantId: TenantId): void {
	if (record.tenantId !== tenantId) {
		throw new TenantIsolationError({
			requested: tenantId,
			resource: `session-goal(${record.sessionId})`,
		})
	}
}

function currentGoal(
	record: SessionGoalRecord | null,
	sessionId: SessionId,
	tenantId: TenantId,
	ref: GoalRef,
): SessionGoal {
	if (!record) throw new GoalNotFoundError(sessionId)
	assertTenant(record, tenantId)
	if (record.sessionId !== sessionId) throw new Error('Session goal storage key mismatch.')
	const goal = record.goal
	if (!goal) throw new GoalNotFoundError(sessionId)
	if (goal.id !== ref.id || goal.revision !== ref.revision) {
		throw new StaleGoalError({
			sessionId,
			expectedRevision: ref.revision,
			actualRevision: goal.revision,
		})
	}
	return goal
}

abstract class SessionGoalStoreBase implements SessionGoalStore {
	protected constructor(
		protected readonly sessions: Pick<SessionStore, 'getSession'>,
		protected readonly now: () => number,
		protected readonly makeGoalId: () => GoalId,
	) {}

	protected abstract put(record: SessionGoalRecord): Promise<void>

	private async requireSession(sessionId: SessionId, tenantId: TenantId): Promise<SessionId> {
		const checked = validSessionId(sessionId)
		if (!(await this.sessions.getSession(checked, tenantId))) {
			throw new GoalSessionNotFoundError(checked)
		}
		return checked
	}

	async getGoal(sessionId: SessionId, tenantId: TenantId): Promise<SessionGoal | null> {
		const checked = await this.requireSession(sessionId, tenantId)
		const record = await backendFor(this).read(checked)
		if (!record) return null
		assertTenant(record, tenantId)
		if (record.sessionId !== checked) throw new Error('Session goal storage key mismatch.')
		return record.goal
	}

	async createGoal(params: CreateSessionGoalParams, tenantId: TenantId): Promise<SessionGoal> {
		const sessionId = await this.requireSession(params.sessionId, tenantId)
		const text = objective(params.objective)
		const maxRounds = maxGoalRounds(params.maxGoalRounds)
		const guards = goalGuards(params.guards)
		if (
			params.confirmedBy !== undefined &&
			params.confirmedBy !== 'model' &&
			params.confirmedBy !== 'record'
		) {
			throw new TypeError('goal confirmedBy must be "model" or "record".')
		}
		return await backendFor(this).transact(sessionId, (existing) => {
			if (existing) {
				assertTenant(existing, tenantId)
				if (existing.goal && existing.goal.phase !== 'complete') {
					throw new GoalExistsError(existing.goal)
				}
			}
			const now = this.now()
			const goal: SessionGoal = {
				id: this.makeGoalId(),
				sessionId,
				tenantId,
				revision: 1,
				objective: text,
				phase: 'active',
				maxGoalRounds: maxRounds,
				roundsAdmitted: 0,
				...(guards !== undefined ? { guards } : {}),
				...(params.confirmedBy !== undefined ? { confirmedBy: params.confirmedBy } : {}),
				createdAt: now,
				updatedAt: now,
			}
			const record: SessionGoalRecord = {
				sessionId,
				tenantId,
				storageRevision: (existing?.storageRevision ?? 0) + 1,
				goal,
				updatedAt: now,
			}
			return { record, result: goal }
		})
	}

	async editGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		changes: EditSessionGoalParams,
	): Promise<SessionGoal> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		const nextObjective = objective(changes.objective)
		return await this.mutate(checked, tenantId, expected, (goal) => {
			if (goal.phase === 'complete') throw new GoalTransitionError(goal.phase, 'edit')
			return {
				...goal,
				objective: nextObjective,
			}
		})
	}

	async pauseGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal> {
		return await this.transition(sessionId, tenantId, ref, 'pause', ['active'], 'paused')
	}

	async resumeGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		options: ResumeSessionGoalOptions = {},
	): Promise<SessionGoal> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		const raisedRounds = guardNumber('maxGoalRounds', options.maxGoalRounds, 1)
		const raisedBudget = guardNumber('tokenBudget', options.tokenBudget, 1)
		return await this.mutate(checked, tenantId, expected, (goal) => {
			if (goal.phase !== 'paused' && goal.phase !== 'blocked') {
				throw new GoalTransitionError(goal.phase, 'resume')
			}
			const {
				blockedReason: _blockedReason,
				pauseReason: _pauseReason,
				quietRounds: _quietRounds,
				failureRounds: _failureRounds,
				failureSignature: _failureSignature,
				wrapUpRound: _wrapUpRound,
				...rest
			} = goal
			// A resume starts the stall counts again; the round count and the
			// check-in position are never reset, so a check-in resumed continues.
			// A rule the host sets on resume replaces the stored one, so a
			// check-in of 0 turns it off and a looser limit takes effect.
			const filled = goalGuards(options.guards)
			const own: GoalGuards | undefined =
				filled === undefined && goal.guards === undefined
					? undefined
					: { ...goal.guards, ...filled }
			const budget =
				raisedBudget !== undefined && raisedBudget > (own?.tokenBudget ?? 0)
					? raisedBudget
					: own?.tokenBudget
			const guards: GoalGuards | undefined =
				own === undefined && budget === undefined
					? undefined
					: { ...own, ...(budget !== undefined ? { tokenBudget: budget } : {}) }
			// A check-in rule added or changed now counts from here, not from the first round.
			const newCheckIn =
				filled?.checkInEvery !== undefined &&
				filled.checkInEvery > 0 &&
				filled.checkInEvery !== goal.guards?.checkInEvery
			return {
				...rest,
				phase: 'active',
				...(newCheckIn ? { checkedInAtRound: goal.roundsAdmitted } : {}),
				maxGoalRounds:
					raisedRounds !== undefined && raisedRounds > goal.maxGoalRounds
						? raisedRounds
						: goal.maxGoalRounds,
				...(guards !== undefined ? { guards } : {}),
			}
		})
	}

	async admitRound(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
	): Promise<GoalRoundAuthority> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		const outcome = await backendFor(this).transact<AdmitOutcome>(checked, (existing) => {
			const goal = currentGoal(existing, checked, tenantId, expected)
			if (goal.phase !== 'active') throw new GoalTransitionError(goal.phase, 'admit a round for')
			const now = this.now()
			const stop = (
				reason: GoalBlockReason,
				extra: Partial<SessionGoal> = {},
			): { record: SessionGoalRecord; result: AdmitOutcome } => {
				const blocked: SessionGoal = {
					...goal,
					...extra,
					revision: goal.revision + 1,
					phase: 'blocked',
					blockedReason: reason,
					updatedAt: now,
				}
				return {
					record: {
						sessionId: checked,
						tenantId,
						storageRevision: (existing?.storageRevision ?? 0) + 1,
						goal: blocked,
						updatedAt: now,
					},
					result: { kind: 'exhausted', goal: blocked },
				}
			}
			if (goal.roundsAdmitted >= goal.maxGoalRounds) {
				return stop({
					code: 'round-limit',
					message: `Reached the ${goal.maxGoalRounds}-round limit.`,
				})
			}
			const budget = goal.guards?.tokenBudget
			const overBudget = budget !== undefined && (goal.tokensUsed ?? 0) >= budget
			if (overBudget && goal.wrapUpRound !== undefined) {
				return {
					...stop({
						code: 'budget-limited',
						message: `Reached the ${budget.toLocaleString('en-US')}-token budget after ${goalUsageSentence(goal)}.`,
					}),
				}
			}
			const checkInEvery = goal.guards?.checkInEvery ?? 0
			if (
				!overBudget &&
				checkInEvery > 0 &&
				goal.roundsAdmitted - (goal.checkedInAtRound ?? 0) >= checkInEvery
			) {
				const paused: SessionGoal = {
					...goal,
					revision: goal.revision + 1,
					phase: 'paused',
					pauseReason: {
						code: 'check-in',
						message: `Paused for a check-in after ${goalUsageSentence(goal)}.`,
					},
					checkedInAtRound: goal.roundsAdmitted,
					updatedAt: now,
				}
				return {
					record: {
						sessionId: checked,
						tenantId,
						storageRevision: (existing?.storageRevision ?? 0) + 1,
						goal: paused,
						updatedAt: now,
					},
					result: { kind: 'check-in', goal: paused },
				}
			}

			const { missing: _missing, ...withoutMissing } = goal
			const admitted: SessionGoal = {
				...withoutMissing,
				revision: goal.revision + 1,
				roundsAdmitted: goal.roundsAdmitted + 1,
				...(overBudget ? { wrapUpRound: goal.roundsAdmitted + 1 } : {}),
				updatedAt: now,
			}
			const authority: GoalRoundAuthority = {
				id: admitted.id,
				revision: admitted.revision,
				sessionId: admitted.sessionId,
				tenantId: admitted.tenantId,
				objective: admitted.objective,
				round: admitted.roundsAdmitted,
				maxGoalRounds: admitted.maxGoalRounds,
				...(goal.tokensUsed !== undefined ? { tokensUsed: goal.tokensUsed } : {}),
				...(goal.costUsd !== undefined ? { costUsd: goal.costUsd } : {}),
				...(overBudget ? { wrapUp: true } : {}),
				...(goal.missing && goal.missing.length > 0 ? { missing: goal.missing } : {}),
			}
			return {
				record: {
					sessionId: checked,
					tenantId,
					storageRevision: (existing?.storageRevision ?? 0) + 1,
					goal: admitted,
					updatedAt: now,
				},
				result: { kind: 'admitted', authority },
			}
		})
		if (outcome.kind === 'check-in') throw new GoalCheckInError(outcome.goal)
		if (outcome.kind === 'exhausted') {
			if (outcome.goal.blockedReason?.code === 'budget-limited') {
				throw new GoalBudgetLimitError(outcome.goal)
			}
			throw new GoalRoundLimitError(outcome.goal)
		}
		return outcome.authority
	}

	async recordRound(
		sessionId: SessionId,
		tenantId: TenantId,
		goalId: GoalId,
		outcome: GoalRoundOutcome,
	): Promise<SessionGoal | null> {
		const checked = await this.requireSession(sessionId, tenantId)
		const id = asGoalId(goalId)
		const before = await backendFor(this).read(checked)
		if (!before || before.goal?.id !== id) return null
		return await backendFor(this).transact<SessionGoal | null>(checked, (existing) => {
			if (!existing) throw new GoalNotFoundError(checked)
			assertTenant(existing, tenantId)
			const goal = existing.goal
			const now = this.now()
			if (!goal || goal.id !== id) {
				// The goal was replaced while this was read: nothing to add to.
				return {
					record: {
						sessionId: checked,
						tenantId,
						storageRevision: existing.storageRevision + 1,
						goal: existing.goal,
						updatedAt: now,
					},
					result: null,
				}
			}
			const guards = goal.guards
			const empty = outcome.progress === 'empty'
			const quietRounds = empty ? (goal.quietRounds ?? 0) + 1 : 0
			const sameFailure =
				outcome.failureSignature !== undefined && outcome.failureSignature === goal.failureSignature
			const failureRounds =
				outcome.failureSignature === undefined ? 0 : sameFailure ? (goal.failureRounds ?? 0) + 1 : 1
			const { failureSignature: _drop, missing: _missing, lastAction: _lastAction, ...rest } = goal
			const lastAction = outcome.action ?? goal.lastAction
			const missing = outcome.missing !== undefined ? outcome.missing : goal.missing
			let updated: SessionGoal = {
				...rest,
				tokensUsed: (goal.tokensUsed ?? 0) + Math.max(0, outcome.tokens ?? 0),
				costUsd: (goal.costUsd ?? 0) + Math.max(0, outcome.costUsd ?? 0),
				quietRounds,
				failureRounds,
				...(outcome.failureSignature !== undefined
					? { failureSignature: outcome.failureSignature }
					: {}),
				...(lastAction !== undefined ? { lastAction } : {}),
				...(missing !== undefined && missing.length > 0 ? { missing } : {}),
				updatedAt: now,
			}
			const stall = guards?.stallRounds
			if (goal.phase === 'active' && stall !== undefined) {
				const after = lastAction !== undefined ? ` Last action: ${lastAction}.` : ''
				if (quietRounds >= stall) {
					updated = {
						...updated,
						revision: goal.revision + 1,
						phase: 'blocked',
						blockedReason: {
							code: 'no-progress',
							message: `${stall} automatic turns in a row changed nothing and checked nothing.${after}`,
						},
					}
				} else if (failureRounds >= stall && outcome.failureSignature !== undefined) {
					updated = {
						...updated,
						revision: goal.revision + 1,
						phase: 'blocked',
						blockedReason: {
							code: 'repeated-failure',
							message: `The same failure ended ${stall} automatic turns in a row: ${outcome.failureSignature}.${after}`,
						},
					}
				}
			}
			return {
				record: {
					sessionId: checked,
					tenantId,
					storageRevision: existing.storageRevision + 1,
					goal: updated,
					updatedAt: now,
				},
				result: updated,
			}
		})
	}

	async completeGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal> {
		return await this.transition(
			sessionId,
			tenantId,
			ref,
			'complete',
			['active', 'paused', 'blocked'],
			'complete',
		)
	}

	async blockGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		reason: GoalBlockReason,
	): Promise<SessionGoal> {
		const validated = blockReason(reason)
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		return await this.mutate(checked, tenantId, expected, (goal) => {
			if (goal.phase !== 'active') throw new GoalTransitionError(goal.phase, 'block')
			return { ...goal, phase: 'blocked', blockedReason: validated }
		})
	}

	async clearGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<void> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		await backendFor(this).transact(checked, (existing) => {
			currentGoal(existing, checked, tenantId, expected)
			const now = this.now()
			return {
				record: {
					sessionId: checked,
					tenantId,
					storageRevision: (existing?.storageRevision ?? 0) + 1,
					goal: null,
					updatedAt: now,
				},
				result: undefined,
			}
		})
	}

	private async transition(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		operation: string,
		from: readonly GoalPhase[],
		to: GoalPhase,
	): Promise<SessionGoal> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		return await this.mutate(checked, tenantId, expected, (goal) => {
			if (!from.includes(goal.phase)) throw new GoalTransitionError(goal.phase, operation)
			const { blockedReason: _blockedReason, ...rest } = goal
			return { ...rest, phase: to }
		})
	}

	private async mutate(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		change: (goal: SessionGoal) => Omit<SessionGoal, 'revision' | 'updatedAt'>,
	): Promise<SessionGoal> {
		return await backendFor(this).transact(sessionId, (existing) => {
			const goal = currentGoal(existing, sessionId, tenantId, ref)
			const now = this.now()
			const updated: SessionGoal = {
				...change(goal),
				revision: goal.revision + 1,
				updatedAt: now,
			}
			return {
				record: {
					sessionId,
					tenantId,
					storageRevision: (existing?.storageRevision ?? 0) + 1,
					goal: updated,
					updatedAt: now,
				},
				result: updated,
			}
		})
	}
}

export interface InMemorySessionGoalStoreConfig {
	readonly sessions: Pick<SessionStore, 'getSession'>
}

export class InMemorySessionGoalStore extends SessionGoalStoreBase {
	private readonly records = new Map<SessionId, SessionGoalRecord>()

	constructor(
		config: InMemorySessionGoalStoreConfig,
		now: () => number = Date.now,
		makeGoalId: () => GoalId = generateGoalId,
	) {
		super(config.sessions, now, makeGoalId)
		backends.set(this, {
			read: async (sessionId) => this.records.get(sessionId) ?? null,
			transact: async <R>(
				sessionId: SessionId,
				mutate: (current: SessionGoalRecord | null) => RevisionMutation<SessionGoalRecord, R>,
			) => {
				const proposal = mutate(this.records.get(sessionId) ?? null)
				await this.put(proposal.record)
				return proposal.result
			},
		})
	}

	protected async put(record: SessionGoalRecord): Promise<void> {
		const existing = this.records.get(record.sessionId)
		if (existing) assertTenant(existing, record.tenantId)
		const actual = existing?.storageRevision ?? 0
		if (record.storageRevision !== actual + 1) {
			throw new StaleGoalError({
				sessionId: record.sessionId,
				expectedRevision: record.storageRevision - 1,
				actualRevision: existing?.goal?.revision ?? 0,
			})
		}
		this.records.set(record.sessionId, record)
	}
}

export interface DiskSessionGoalStoreConfig {
	/** Session root; goals live under `<rootDir>/goals/`. */
	readonly rootDir: string
	/** Authority for session existence and tenant ownership. */
	readonly sessions: Pick<SessionStore, 'getSession'>
}

export class DiskSessionGoalStore extends SessionGoalStoreBase {
	constructor(
		private readonly config: DiskSessionGoalStoreConfig,
		now: () => number = Date.now,
		makeGoalId: () => GoalId = generateGoalId,
	) {
		super(config.sessions, now, makeGoalId)
		backends.set(this, {
			read: async (sessionId) => await revisionRecords.read(this.location(sessionId)),
			transact: async <R>(
				sessionId: SessionId,
				mutate: (current: SessionGoalRecord | null) => RevisionMutation<SessionGoalRecord, R>,
			): Promise<R> => {
				const location = this.location(sessionId)
				const proposal = mutate(await revisionRecords.read(location))
				try {
					await this.put(proposal.record)
				} catch (error) {
					if (error instanceof StaleGoalError) mutate(await revisionRecords.read(location))
					throw error
				}
				return proposal.result
			},
		})
	}

	private location(sessionId: SessionId): RevisionedRecordLocation {
		const root = join(this.config.rootDir, 'goals')
		const segment = revisionFileSegment(sessionId)
		return {
			legacyPath: join(root, `${segment}.json`),
			revisionsDir: join(root, '.revisions', segment),
		}
	}

	protected async put(record: SessionGoalRecord): Promise<void> {
		await revisionRecords.transact(this.location(record.sessionId), (existing) => {
			if (existing) assertTenant(existing, record.tenantId)
			const actual = existing?.storageRevision ?? 0
			if (record.storageRevision !== actual + 1) {
				throw new StaleGoalError({
					sessionId: record.sessionId,
					expectedRevision: record.storageRevision - 1,
					actualRevision: existing?.goal?.revision ?? 0,
				})
			}
			return { record, result: undefined }
		})
	}
}
