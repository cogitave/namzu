/**
 * SessionSummaryMaterializer — kernel terminalization primitive.
 *
 * The sole producer of {@link SessionSummaryRef}. No agent-callable surface
 * exists to bypass this (Convention #0 load-bearing — see
 * session-hierarchy.md §8.1).
 *
 * Atomicity contract (§8.1): the summary write and the owning session's
 * `non-terminal → idle` status flip commit as one logical unit. In the
 * InMemory store the two happen within the same method call under the store's
 * Map guard; in the Disk store they are two sequential write-tmp-renames
 * (summary.json first, then session.json). A mid-step crash leaves the
 * summary persisted but the session still active — `recover()` replays the
 * session-status flip idempotently on next boot.
 *
 * The class is function-call-style (no internal state beyond deps). Tests
 * inject a fake generator for deterministic IDs; production uses
 * `generateSummaryId` from `utils/id.ts`.
 */

import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { Session } from '../../types/session/entity.js'
import type { SummaryId } from '../../types/session/ids.js'
import type { SessionStore } from '../../types/session/store.js'
import type { DeliverableRef } from '../../types/summary/deliverable.js'
import {
	AGENT_SUMMARY_MAX_CHARS,
	type SessionSummaryKeyDecision,
	type SessionSummaryOutcome,
	type SessionSummaryRef,
} from '../../types/summary/ref.js'
import { AgentSummaryTooLongError, SessionAlreadySummarizedError } from './errors.js'

/**
 * Dependencies for {@link SessionSummaryMaterializer}. The generator is
 * injected so tests can produce deterministic IDs; production code wires
 * `generateSummaryId` from `utils/id.ts`.
 */
export interface SessionSummaryMaterializerDeps {
	readonly store: SessionStore
	readonly generateSummaryId: () => SummaryId
	/** Clock hook — defaults to `new Date()` when omitted. */
	readonly now?: () => Date
}

/**
 * Caller-supplied payload for {@link SessionSummaryMaterializer.materialize}.
 * The materializer validates `agentSummary` length, constructs the
 * `SessionSummaryRef`, and delegates the atomic write to the store.
 */
export interface MaterializeInput {
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	readonly finalOutcome: SessionSummaryOutcome
	readonly agentSummary: string
	readonly declaredDeliverables: readonly DeliverableRef[]
	readonly keyDecisions: readonly SessionSummaryKeyDecision[]
}

/**
 * Session statuses from which a materialize call may legally transition to
 * `'idle'` as part of the terminalization. Other states (already `'idle'`,
 * `'failed'`, `'archived'`, `'awaiting_hitl'`) are left untouched; the
 * materializer never moves a session *out of* `'failed'` or `'archived'`.
 */
const TERMINALIZABLE_STATUSES: ReadonlySet<Session['status']> = new Set([
	'active',
	'locked',
	'awaiting_merge',
])

export class SessionSummaryMaterializer {
	private readonly deps: SessionSummaryMaterializerDeps

	constructor(deps: SessionSummaryMaterializerDeps) {
		this.deps = deps
	}

	/**
	 * Kernel emission path. Validates, builds the immutable
	 * {@link SessionSummaryRef}, and hands it to the store for atomic write +
	 * status-flip. Rejects with:
	 *
	 * - {@link AgentSummaryTooLongError} — `agentSummary` exceeds the max char
	 *   cap ({@link AGENT_SUMMARY_MAX_CHARS}).
	 * - `TenantIsolationError` — session is owned by a different tenant.
	 * - {@link SessionAlreadySummarizedError} — the session already has a
	 *   persisted summary. Re-materialization would duplicate history; the
	 *   caller should instead open an intervention sub-session (§4.5).
	 */
	async materialize(input: MaterializeInput): Promise<SessionSummaryRef> {
		this.assertSummaryLength(input.agentSummary)

		const session = await this.deps.store.getSession(input.sessionId, input.tenantId)
		if (!session) {
			throw new Error(`Session ${input.sessionId} not found`)
		}

		const existing = await this.deps.store.getSummary(input.sessionId, input.tenantId)
		if (existing) {
			throw new SessionAlreadySummarizedError({
				sessionId: input.sessionId,
				existingSummaryId: existing.id,
			})
		}

		const summary: SessionSummaryRef = {
			id: this.deps.generateSummaryId(),
			sessionRef: input.sessionId,
			tenantId: input.tenantId,
			outcome: input.finalOutcome,
			deliverables: input.declaredDeliverables,
			agentSummary: input.agentSummary,
			keyDecisions: input.keyDecisions,
			at: this.clock(),
			materializedBy: 'kernel',
		}

		await this.deps.store.recordSummary(summary, input.tenantId)
		return summary
	}

	/**
	 * Recovery path. Called at boot (or explicitly by the lifecycle manager)
	 * for sessions whose `summary.json` is persisted but whose `session.json`
	 * still reports a non-terminal status — the crash window between the two
	 * atomic writes on disk.
	 *
	 * Idempotent: if the session is already `'idle'` (or another terminal
	 * state), no write occurs; the existing summary is returned. If no summary
	 * is persisted, returns `null` and no side effect occurs. This is the only
	 * non-materialize path that may touch the stored summary — it does not
	 * mint a new ID, only re-triggers the store's status flip via
	 * `recordSummary` when it detects the dangling session.
	 */
	async recover(sessionId: SessionId, tenantId: TenantId): Promise<SessionSummaryRef | null> {
		const summary = await this.deps.store.getSummary(sessionId, tenantId)
		if (!summary) return null

		const session = await this.deps.store.getSession(sessionId, tenantId)
		if (!session) return summary

		if (TERMINALIZABLE_STATUSES.has(session.status)) {
			// Dangling: summary persisted but session never flipped. Replay the
			// status transition by re-invoking `recordSummary` — store impls
			// treat an existing-summary path as "flip-only, no duplicate write".
			// Cast preserves the kernel brand on the recovered record.
			await this.deps.store.recordSummary(
				summary as SessionSummaryRef & { materializedBy: 'kernel' },
				tenantId,
			)
		}
		return summary
	}

	private assertSummaryLength(agentSummary: string): void {
		if (agentSummary.length > AGENT_SUMMARY_MAX_CHARS) {
			throw new AgentSummaryTooLongError({
				actual: agentSummary.length,
				max: AGENT_SUMMARY_MAX_CHARS,
			})
		}
	}

	private clock(): Date {
		return this.deps.now ? this.deps.now() : new Date()
	}
}
