import type { CostInfo } from '../common/index.js'
import type { AuditEventId, SessionId, TenantId, TurnId } from '../ids/index.js'
import type { TurnExecutionStatus } from './turn.js'

/**
 * What happened to the thing this event describes.
 *
 * `'refused'` is a VALUE, not an absent record — the whole reason this type
 * exists rather than reusing whatever shape {@link import('./events.js').SessionEvent}
 * already had. Before this, a permission denial (the `AuthorizationGate`) and
 * a guardrail block each produced nothing durable with cost/outcome/identity
 * attached — the one outcome an auditor most needs was the one absent from
 * the trail. See ses_020's logging design §5.
 */
export type AuditOutcome = 'success' | 'failure' | 'refused'

/**
 * Who acted, in the compliance-audit sense: the actor's identity and the
 * tenant it acted under.
 *
 * `persona` is the label a host assigned the agent for THIS run — absent
 * when the turn was not configured with one (most runs today), and nothing
 * here invents a value for it. Populated only at call sites that actually
 * have a persona in scope (`runtime/query/index.ts`'s guardrail-block
 * branches, via `params.persona?.identity.role`); a call site with no
 * persona in scope (the verification-gate denial inside `tool-review.ts`)
 * legitimately omits it rather than guessing.
 */
export interface AuditActor {
	readonly agentId: string
	readonly tenantId: TenantId
	readonly persona?: string
}

/**
 * What was attempted. `tool` is present for a tool-scoped action; absent for
 * a turn-level one (an input/output guardrail, the turn's own completion or
 * failure). `resource` names the thing the action targeted when that is
 * narrower than the tool itself — a guardrail's own name, for instance.
 *
 * `action` is deliberately a free-text label, not a closed union: unlike
 * `SessionEvent['type']` (which a switch must exhaustively handle, per
 * Convention #16), nothing here switches on `action` today, and closing it
 * prematurely would be inventing a vocabulary nobody has asked to enumerate
 * yet.
 */
export interface AuditAction {
	readonly action: string
	readonly tool?: string
	readonly resource?: string
}

/**
 * One entry in a session's audit trail — durable evidence of what the agent
 * did, under whose identity, at what cost, and whether it was allowed.
 *
 * ## Why this is not an operational log line
 *
 * See ses_020's logging design §5 for the full reasoning. It is appended to
 * the session log as an `audit` record. In short: an
 * operational log is level-filtered, sampled, rotatable and legitimately
 * absent when no host installed a sink. None of that is acceptable for the
 * kernel's own claim — "an auditable trail of what it did and what it
 * cost", the README's sentence about itself.
 *
 * ## `seq` is the audit trail's OWN sequence
 *
 * Independent of the session log's record `seq`: the audit entries of a
 * session are numbered among themselves, so a reader can tell whether one is
 * missing.
 *
 * ## `cost` is NON-OPTIONAL
 *
 * "What it did and what it cost" is the kernel's own sentence about itself
 * (README) — an audit entry that cannot say what something cost has not
 * answered the question it exists to answer. It carries the turn's
 * CUMULATIVE total AT THIS MOMENT, matching `Turn.costInfo`'s own semantics
 * (see `utils/cost.ts`'s `accumulateCost`: the field IS the running total,
 * not a delta, so "the most recent entry carries the answer whole" is
 * already how the derived summary treats it — see {@link replayAudit}).
 */
export interface AuditEvent {
	readonly id: AuditEventId
	readonly sessionId: SessionId
	/** Absent for an entry recorded outside any turn. */
	readonly turnId?: TurnId
	readonly seq: number
	/** Epoch ms at which the store recorded the event. */
	readonly timestamp: number
	readonly who: AuditActor
	readonly what: AuditAction
	readonly outcome: AuditOutcome
	readonly cost: CostInfo
	/** Present on `'refused'` and `'failure'` — the reason a reader needs. */
	readonly reason?: string
	/**
	 * The active span's identity at the moment this entry was recorded —
	 * resolved the same way `utils/log/create-logger.ts`'s `emit` resolves
	 * `LogRecord.traceId`/`spanId`: fresh per record, off the live
	 * `@opentelemetry/api` global, never captured once and reused. Genuinely
	 * absent — not `''`, not `'unknown'` — whenever nothing is active. See
	 * `telemetry/runtime-accessors.ts`'s `getActiveSpanContext` for why.
	 */
	readonly traceId?: string
	readonly spanId?: string
}

/**
 * What a caller hands
 * {@link import('../../manager/session/turn-recorder.js').TurnRecorder.recordAudit} —
 * the fields ONLY the call site knows. `id`, `sessionId`, `turnId`, `seq`, `timestamp`,
 * `who.agentId`/`who.tenantId` and `cost` are filled in by `recordAudit`
 * itself from the turn it is bound to; a caller supplying them would be
 * asserting facts about identity and cost that only the turn-persistence
 * layer is positioned to know, and could disagree with what the turn
 * actually holds.
 */
export interface AuditEventInput {
	readonly what: AuditAction
	readonly outcome: AuditOutcome
	readonly reason?: string
	readonly persona?: string
}

/** What {@link replayAudit} reconstructs from the trail alone. */
export interface AuditSummary {
	readonly costInfo: CostInfo
	readonly status: Extract<TurnExecutionStatus, 'completed' | 'failed'>
}

/**
 * Reconstruct a completed turn's cost and status from its audit trail alone,
 * with no read of the derived `Turn`.
 *
 * `Turn.costInfo` and `Turn.status` are a DERIVED summary; the audit trail is
 * the evidence, and a divergence between what this returns and what the
 * summary holds is a defect in the summary, never in the trail.
 *
 * Walks from the END rather than folding forward: `cost` on each entry is
 * already the turn's cumulative total (see {@link AuditEvent.cost}), so the
 * most recent entry that actually SETTLES the turn — `'success'` or
 * `'failure'` — carries the answer whole. A `'refused'` entry is a single
 * action inside a still-open run, never the turn's own verdict, and is
 * skipped rather than treated as terminal: otherwise a refusal that
 * happened to be the last write before a crash would replay as the turn's
 * final status, which is not what it means.
 *
 * `undefined` when no terminal entry exists — a turn still in progress, or
 * one that crashed before a terminal write landed. Callers that need "no
 * answer yet" and "diverges from the derived summary" to read differently
 * should treat `undefined` as the former.
 */
export function replayAudit(events: readonly AuditEvent[]): AuditSummary | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]
		if (event === undefined) continue
		if (event.outcome === 'success') return { costInfo: event.cost, status: 'completed' }
		if (event.outcome === 'failure') return { costInfo: event.cost, status: 'failed' }
	}
	return undefined
}
