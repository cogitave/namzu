import { RunDiskStore } from '../../../store/run/disk.js'
import type { isTerminalStatus } from '../../../types/common/index.js'
import type {
	HITLResumeDecision,
	IterationCheckpoint,
	PendingDecision,
} from '../../../types/hitl/index.js'
import type { CheckpointId, RunId } from '../../../types/ids/index.js'
import type { Logger } from '../../../utils/logger.js'
import { isValidOutcomeFor } from './apply.js'
import {
	DecisionAlreadyResolvedError,
	DecisionNotFoundError,
	DecisionOutcomeInvalidError,
	DecisionTokenInvalidError,
	RunNotResumableError,
} from './errors.js'
import { resumeTokenMatches } from './pending.js'

/**
 * Locate one run's decision record. Every entry here takes this rather than a
 * pre-built store, so the whole state-preparation half stays free of runtime
 * dependencies — no provider, no tool registry, no resume handler
 * ([state-prep-execution-split](../../../../../docs.local/conventions/state-prep-execution-split.md)).
 */
export interface DecisionLocator {
	/** Directory that contains `<runId>/` — the session's `runs` dir. */
	baseDir: string
	runId: RunId
	checkpointId: CheckpointId
	logger?: Logger
}

export interface ResumeDecisionInput extends DecisionLocator {
	/** The capability that permits this decision to be answered. Single-use. */
	resumeToken: string
	/** What the reviewer decided. */
	decision: HITLResumeDecision
}

/**
 * The materials a caller threads into `query()` to actually run the resume.
 *
 * The execution half is deliberately NOT bundled in: `query()` needs a provider, a tool
 * registry, session scope and a sandbox — none of which can be reconstituted from the
 * durable record, and fabricating them here would produce a resumed run that behaves
 * differently from the original. The caller owns them, so the caller supplies them:
 *
 * ```ts
 * const prepared = await resumeDecision({ baseDir, runId, checkpointId, resumeToken, decision })
 * await drainQuery({
 *   resumeFromCheckpoint: prepared.checkpointId,   // ← the dispatcher picks the decision up here
 *   runId: prepared.runId,                          // ← same logical run, same ledger
 *   provider, tools, runConfig, agentId, agentName, // ← caller-owned runtime
 *   sessionId, threadId, projectId, tenantId,
 *   workingDirectory,
 *   messages: [],                                   // ← IGNORED on the resume branch; history comes from the checkpoint
 * })
 * ```
 */
export interface PreparedDecisionResume {
	runId: RunId
	checkpointId: CheckpointId
	/** The checkpoint with the outcome recorded on it (`state: 'resolved'`). */
	checkpoint: IterationCheckpoint
	decision: PendingDecision
}

/**
 * Read a run's pending decision, token included.
 *
 * **Server-side only.** The resume token is a capability, so this is the authorized,
 * unicast read that hands it to whoever is entitled to answer — which is exactly why
 * the token is not on the event stream, where every subscriber would see it.
 */
export async function readPendingDecision(
	locator: DecisionLocator,
): Promise<PendingDecision | null> {
	const store = new RunDiskStore({ baseDir: locator.baseDir, logger: locator.logger })
	await store.initRun(locator.runId)
	const checkpoint = await store.readCheckpoint(locator.checkpointId)
	return checkpoint?.pendingDecision ?? null
}

/**
 * Answer a paused decision: validate the token, record the outcome, and hand back the
 * state a resume needs. The **state-preparation** half of durable resume.
 *
 * The order of the four checks is the design:
 *
 *   1. **Is the run still resumable?** Asked of the run's own persisted status, not of
 *      the decision. This is P4's guarantee arriving through this path: a cancelled run
 *      is unresumable *by construction*, and does not depend on whoever cancelled it
 *      having also remembered to close its open decisions. Only an `awaiting_input` run
 *      may be resumed.
 *   2. **Is there a decision to answer?** Absent → `DecisionNotFoundError`.
 *   3. **Has it already been answered?** Any state past `pending` → the token is spent,
 *      and this is what makes it single-use. The recorded outcome rides on the error so
 *      the route can tell an exact duplicate (answer with it) from a conflicting one
 *      (refuse), instead of returning a reflexive "idempotent 200" to a client that
 *      just changed its mind after the tools ran.
 *   4. **Is the token right?** Constant-time. Checked LAST, after the cheap structural
 *      checks, and raised identically for a malformed, stale or foreign token.
 *
 * Possessing the token gets you here. It does not get you authorization: **the route
 * that calls this still has to establish that the caller owns the run.** A leaked
 * resume token must not BE an authorization — n8n's Ni8mare (CVE-2026-21858) is the
 * in-the-wild proof that the endpoint resuming a paused execution is a real attack
 * surface.
 */
export async function resumeDecision(input: ResumeDecisionInput): Promise<PreparedDecisionResume> {
	const store = new RunDiskStore({ baseDir: input.baseDir, logger: input.logger })
	await store.initRun(input.runId)

	const meta = await store.readRunMeta()
	if (!meta) {
		throw new DecisionNotFoundError(input.runId, input.checkpointId)
	}
	if (meta.status !== 'awaiting_input') {
		throw new RunNotResumableError(input.runId, meta.status)
	}

	let failure: Error | undefined

	const updated = await store.updateCheckpoint(input.checkpointId, (checkpoint) => {
		const decision = checkpoint.pendingDecision
		if (!decision) {
			failure = new DecisionNotFoundError(input.runId, input.checkpointId)
			return undefined
		}
		if (decision.state !== 'pending') {
			failure = new DecisionAlreadyResolvedError(
				input.runId,
				decision.requestId,
				decision.state,
				decision.outcome,
			)
			return undefined
		}
		if (!resumeTokenMatches(decision.resumeToken, input.resumeToken)) {
			failure = new DecisionTokenInvalidError(input.runId, decision.requestId)
			return undefined
		}
		if (!isValidOutcomeFor(decision.request.type, input.decision.action)) {
			failure = new DecisionOutcomeInvalidError(
				input.runId,
				decision.requestId,
				decision.request.type,
				input.decision.action,
			)
			return undefined
		}

		const now = Date.now()
		return {
			...checkpoint,
			pendingDecision: {
				...decision,
				state: 'resolved',
				outcome: input.decision,
				redeemedAt: now,
				updatedAt: now,
			},
		}
	})

	if (failure) throw failure
	if (!updated?.pendingDecision) {
		throw new DecisionNotFoundError(input.runId, input.checkpointId)
	}

	return {
		runId: input.runId,
		checkpointId: input.checkpointId,
		checkpoint: updated,
		decision: updated.pendingDecision,
	}
}

/**
 * Close an open decision because the run was cancelled.
 *
 * Cancel must reach the decision, not just the run: a suspended run has no live process
 * to signal, so without this the decision would sit `pending` on disk forever and only
 * the run-status check in {@link resumeDecision} would stand between a leaked token and
 * a resumed cancelled run. Belt and braces — the status check is the structural
 * guarantee, this is the explicit one.
 *
 * First-writer-wins against a concurrent redemption (plan §D1): a decision already
 * `resolved` or `executing` is left alone, because those states mean tools may be in
 * flight and rewriting the record would lose the journal that says which. Cancelling
 * the RUN still stops it; this only governs whether the decision can still be answered.
 *
 * Idempotent: cancelling an already-cancelled decision is a no-op.
 */
export async function cancelDecision(locator: DecisionLocator): Promise<PendingDecision | null> {
	const store = new RunDiskStore({ baseDir: locator.baseDir, logger: locator.logger })
	await store.initRun(locator.runId)

	const updated = await store.updateCheckpoint(locator.checkpointId, (checkpoint) => {
		const decision = checkpoint.pendingDecision
		if (!decision) return undefined
		if (decision.state !== 'pending') return undefined

		return {
			...checkpoint,
			pendingDecision: {
				...decision,
				state: 'cancelled',
				updatedAt: Date.now(),
			},
		}
	})

	return updated?.pendingDecision ?? null
}

/**
 * Is a terminal-status run being asked to resume? Exposed so callers that hold a `Run`
 * rather than a store can ask the same question the way {@link resumeDecision} does.
 */
export function isResumableStatus(status: Parameters<typeof isTerminalStatus>[0]): boolean {
	return status === 'awaiting_input'
}
