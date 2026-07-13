import { RunDiskStore } from '../../../store/run/disk.js'
import type { AgentStatus } from '../../../types/common/index.js'
import { isTerminalStatus } from '../../../types/common/index.js'
import type {
	DecisionClaim,
	HITLResumeDecision,
	IterationCheckpoint,
	PendingDecision,
} from '../../../types/hitl/index.js'
import type { CheckpointId, RunId } from '../../../types/ids/index.js'
import { RunLeaseHeldError, type RunLeaseView } from '../../../types/run/lease.js'
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
	/**
	 * The run's parent, when it is a CHILD run. Load-bearing, not decorative: a child's
	 * record lives at `baseDir/<parentRunId>/children/<runId>`, and a locator without it
	 * resolves `baseDir/<runId>` — a directory `initRun` then CREATES, empty. Every read
	 * against a suspended sub-agent came back `DecisionNotFoundError` and left a stray
	 * directory behind.
	 */
	parentRunId?: RunId
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

/** Where a run's directory is, without which of its checkpoints you mean. */
export type RunLocator = Omit<DecisionLocator, 'checkpointId'>

async function storeFor(locator: RunLocator): Promise<RunDiskStore> {
	const store = new RunDiskStore({ baseDir: locator.baseDir, logger: locator.logger })
	await store.initRun(locator.runId, locator.parentRunId)
	return store
}

/**
 * How long redemption holds the run, and why it is short.
 *
 * A redemption is not a segment: it validates a token, writes a claim and stamps an outcome
 * onto a checkpoint. It takes the lease only to FENCE a stalled holder off the run while it
 * does so, and it gives it straight back. The TTL is the blast radius if the redeeming
 * process dies mid-write — the run is unresumable for this long, and no longer.
 */
const REDEMPTION_LEASE_TTL_MS = 10_000

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
	const store = await storeFor(locator)
	const checkpoint = await store.readCheckpoint(locator.checkpointId)
	return checkpoint?.pendingDecision ?? null
}

/**
 * Who is driving this run — the operator-facing read of its lease (ses_017 G1).
 *
 * The answer has three shapes, and reporting them as two is how a crashed run gets
 * described as a run waiting for a human:
 *
 *   - `free` — nobody. With `run.json` reading `awaiting_input`, that is a **parked** run:
 *     it stopped for a decision, it released its lease on the way out, and it is safe to
 *     resume right now.
 *   - `held` — a live segment took the lease and is renewing it. Not parked, whatever the
 *     run's last persisted status happens to say — a segment that is mid-iteration has not
 *     written anything since it started.
 *   - `stale` — a segment took the lease and stopped renewing. It is presumed dead, and
 *     `expiresAt` says since when. The run can be taken over (the takeover fences the old
 *     holder's writes), but it must not be *reported* as parked: nobody is waiting on a
 *     human here, something died.
 */
export async function readRunLease(locator: RunLocator): Promise<RunLeaseView> {
	const store = await storeFor(locator)
	return store.readLease()
}

/**
 * Answer a paused decision: validate the token, record the outcome, and hand back the
 * state a resume needs. The **state-preparation** half of durable resume.
 *
 * The order of the checks is the design:
 *
 *   1. **Is the run still resumable?** Asked of the run's own persisted status, not of
 *      the decision. This is P4's guarantee arriving through this path: a cancelled run
 *      is unresumable *by construction*, and does not depend on whoever cancelled it
 *      having also remembered to close its open decisions. Only an `awaiting_input` run
 *      may be resumed.
 *   2. **Is anyone still driving it, and if they are STALLED, take the run off them.** A
 *      live segment holds the lease and the redemption is refused (`RunLeaseHeldError`),
 *      because a token spent against a run nobody may drive strands the human's answer on
 *      disk with no way to retry. A STALE lease is a crashed holder and does not refuse —
 *      but it is TAKEN OVER, not merely noticed, which is the part that was missing: reading
 *      a stale lease fences nobody, so the stalled-but-alive holder kept the current fencing
 *      token and could still write. See the acquisition below for what that costs.
 *   3. **Is there a decision to answer?** Absent → `DecisionNotFoundError`.
 *   4. **Has it already been answered?** Any state past `pending` → the token is spent.
 *      The recorded outcome rides on the error so the route can tell an exact duplicate
 *      (answer with it) from a conflicting one (refuse), instead of returning a
 *      reflexive "idempotent 200" to a client that just changed its mind after the
 *      tools ran.
 *   5. **Is the token right?** Constant-time. Checked after the cheap structural checks,
 *      and raised identically for a malformed, stale or foreign token.
 *   6. **Does the outcome answer the question that was asked?**
 *   7. **CLAIM it.** Only now, once every refusal that must spend nothing has had its
 *      chance, is the durable compare-and-set attempted — an exclusive create that
 *      exactly one caller wins ({@link
 *      import('../../../store/run/disk.js').RunDiskStore.claimDecision}). Everything above
 *      is *screening*; this is the arbitration. Before it existed, two concurrent
 *      redemptions of one token both passed every check and both got a
 *      `PreparedDecisionResume` — and the approved batch ran twice.
 *
 * **Exactly one caller may ever leave this function with a prepared resume.** A loser
 * — including one presenting the exact same outcome — is refused with
 * `DecisionAlreadyResolvedError`; the route answers 200 with the recorded outcome and
 * does NOT launch a second resume. "Idempotent" must mean the tools run once, not that
 * both callers are told yes.
 *
 * Possessing the token gets you here. It does not get you authorization: **the route
 * that calls this still has to establish that the caller owns the run.** A leaked
 * resume token must not BE an authorization — n8n's Ni8mare (CVE-2026-21858) is the
 * in-the-wild proof that the endpoint resuming a paused execution is a real attack
 * surface.
 */
export async function resumeDecision(input: ResumeDecisionInput): Promise<PreparedDecisionResume> {
	const store = await storeFor(input)

	const meta = await store.readRunMeta()
	if (!meta) {
		throw new DecisionNotFoundError(input.runId, input.checkpointId)
	}
	if (meta.status !== 'awaiting_input') {
		throw new RunNotResumableError(input.runId, meta.status)
	}

	const lease = await store.readLease()

	// A live segment still holds the run. The token is NOT spent on it: a decision that is
	// recorded against a run nobody may drive leaves the human's answer stranded on disk
	// and the token gone, and the caller with no way to retry (a spent token is refused
	// the second time by design). Refusing here keeps the token valid — retry when the
	// lease frees, which `expiresAt` names.
	if (lease.status === 'held' && lease.lease) {
		throw new RunLeaseHeldError(lease.lease)
	}

	// A STALE lease is a crashed holder, and taking its run over is the recovery the TTL
	// exists to permit — but NOTICING that it is stale, which is all this used to do, takes
	// nothing over. The stalled holder keeps the current fencing token, so it is not fenced
	// by anything: it can wake up after the token has been permanently spent and the outcome
	// written, pass its fence (its token IS still the current one), and write the run out
	// from under the answer — re-parking it on a NEW decision that orphans the one just
	// answered, or terminalizing it, at which point the `query({ resumeFromCheckpoint })`
	// this function just handed back is refused and the approved batch never runs, with the
	// token already gone. Acquiring mints token N+1, and THAT is what fences it.
	//
	// Only on `stale`. A `free` lease has no holder to fence, and taking one there would put
	// the lease in front of the decision CLAIM as the arbiter of concurrent redemptions —
	// so the loser of a race would get a retryable `RunLeaseHeldError` instead of the
	// `DecisionAlreadyResolvedError` carrying the winner's outcome that the errors contract
	// promises it. The claim arbitrates redemption; the lease arbitrates driving.
	if (lease.status === 'stale' && lease.lease) {
		input.logger?.warn(
			'Redeeming a decision on a run whose segment stopped renewing — taking the run over so its stalled holder cannot write over the answer',
			{
				runId: input.runId,
				stalledHolder: lease.lease.holderId,
				stalledToken: lease.lease.token,
			},
		)
		await store.acquireLease(input.runId, {
			ttlMs: REDEMPTION_LEASE_TTL_MS,
			holderId: `redemption:${process.pid}`,
		})
	}

	try {
		const checkpoint = await store.readCheckpoint(input.checkpointId)
		const decision = checkpoint?.pendingDecision
		if (!checkpoint || !decision) {
			throw new DecisionNotFoundError(input.runId, input.checkpointId)
		}
		if (decision.state !== 'pending') {
			throw new DecisionAlreadyResolvedError(
				input.runId,
				decision.requestId,
				decision.state,
				decision.outcome,
			)
		}
		if (!resumeTokenMatches(decision.resumeToken, input.resumeToken)) {
			throw new DecisionTokenInvalidError(input.runId, decision.requestId)
		}
		if (!isValidOutcomeFor(decision.request.type, input.decision.action)) {
			throw new DecisionOutcomeInvalidError(
				input.runId,
				decision.requestId,
				decision.request.type,
				input.decision.action,
			)
		}

		const now = Date.now()
		const lost = await store.claimDecision(input.checkpointId, {
			requestId: decision.requestId,
			outcome: input.decision,
			at: now,
		})

		if (lost) {
			// Somebody else answered this decision. The claim carries THEIR outcome, so the
			// refusal is specific even if the winner has not finished writing the checkpoint
			// yet — and even if the winner CRASHED between the claim and that write, which is
			// why the record is healed here rather than left `pending` with a spent token.
			// That combination is the one shape that would be permanently unanswerable.
			const healed = await settleClaimOntoCheckpoint(store, input.checkpointId, lost)
			throw new DecisionAlreadyResolvedError(
				input.runId,
				decision.requestId,
				healed?.state ?? (lost.cancelled ? 'cancelled' : 'resolved'),
				healed?.outcome ?? lost.outcome,
			)
		}

		const updated = await store.updateCheckpoint(input.checkpointId, (cp) => {
			const pending = cp.pendingDecision
			if (!pending) return undefined
			return {
				...cp,
				pendingDecision: {
					...pending,
					state: 'resolved',
					outcome: input.decision,
					redeemedAt: now,
					updatedAt: now,
				},
			}
		})

		if (!updated?.pendingDecision) {
			throw new DecisionNotFoundError(input.runId, input.checkpointId)
		}

		return {
			runId: input.runId,
			checkpointId: input.checkpointId,
			checkpoint: updated,
			decision: updated.pendingDecision,
		}
	} finally {
		// Handed back the moment the answer is recorded — a no-op unless a stale lease was
		// actually taken over above. Redemption is the state-preparation half; the caller
		// drives the resume itself, and it needs the lease to be free to do it. A redemption
		// that kept the lease would refuse the very `query()` it just prepared.
		await store.releaseLease()
	}
}

/**
 * Write a won claim onto the checkpoint if the winner has not managed to yet.
 *
 * Idempotent, and only ever moves a decision OFF `pending` — never over a `resolved`,
 * `executing` or `settled` record, whose journal says which tools have already run.
 */
async function settleClaimOntoCheckpoint(
	store: RunDiskStore,
	checkpointId: CheckpointId,
	claim: DecisionClaim,
): Promise<PendingDecision | undefined> {
	const updated = await store.updateCheckpoint(checkpointId, (cp) => {
		const pending = cp.pendingDecision
		if (!pending || pending.state !== 'pending') return undefined
		const now = Date.now()
		return {
			...cp,
			pendingDecision: claim.cancelled
				? { ...pending, state: 'cancelled' as const, updatedAt: now }
				: {
						...pending,
						state: 'resolved' as const,
						outcome: claim.outcome,
						redeemedAt: claim.at,
						updatedAt: now,
					},
		}
	})
	return updated?.pendingDecision
}

/**
 * Close an open decision because the run was cancelled.
 *
 * Cancel must reach the decision, not just the run: a suspended run has no live process
 * to signal, so without this the decision sits `pending` on disk forever and only the
 * run-status check in {@link resumeDecision} stands between a leaked token and a
 * resumed cancelled run. Belt and braces — but the braces were never fastened: this had
 * ZERO callers, and that is what made "a cancelled run is unresumable by construction"
 * false the moment the pause became durable. {@link cancelRun} is the seam that calls it.
 *
 * First-writer-wins against a concurrent redemption, decided by the same durable claim
 * the redemption is decided by (plan §D1): whoever creates it wins, and a decision
 * already `resolved` or `executing` is left alone, because those states mean tools may
 * be in flight and rewriting the record would lose the journal that says which.
 * Cancelling the RUN still stops it; this only governs whether the decision can still
 * be answered.
 *
 * Idempotent: cancelling an already-cancelled decision is a no-op.
 */
export async function cancelDecision(locator: DecisionLocator): Promise<PendingDecision | null> {
	const store = await storeFor(locator)
	return cancelDecisionOn(store, locator.checkpointId)
}

async function cancelDecisionOn(
	store: RunDiskStore,
	checkpointId: CheckpointId,
): Promise<PendingDecision | null> {
	const checkpoint = await store.readCheckpoint(checkpointId)
	const decision = checkpoint?.pendingDecision
	if (!decision) return null
	if (decision.state !== 'pending') return decision

	const lost = await store.claimDecision(checkpointId, {
		requestId: decision.requestId,
		cancelled: true,
		at: Date.now(),
	})
	if (lost) {
		// A redemption beat the cancel to the record. Its tools may already be running;
		// the decision keeps the outcome it was answered with. The RUN is still cancelled
		// by the caller — that is what stops it.
		return (await settleClaimOntoCheckpoint(store, checkpointId, lost)) ?? decision
	}

	const updated = await store.updateCheckpoint(checkpointId, (cp) => {
		const pending = cp.pendingDecision
		if (!pending || pending.state !== 'pending') return undefined
		return {
			...cp,
			pendingDecision: { ...pending, state: 'cancelled', updatedAt: Date.now() },
		}
	})
	return updated?.pendingDecision ?? null
}

export interface CancelRunOutcome {
	/** The run's persisted status after the cancel. */
	status: AgentStatus
	/** Checkpoints whose open decision this cancel closed. */
	cancelledDecisions: CheckpointId[]
	/** True when the run was already terminal and nothing was changed. */
	alreadyTerminal: boolean
}

/**
 * Cancel a run **durably** — the seam a cancel path must go through when the run it is
 * cancelling may be parked.
 *
 * A suspended run has no live process. Aborting an `AbortSignal` reaches nobody: the
 * generator returned when the run parked, and P4's cancel machinery has nothing to
 * signal. So a cancel that only signals leaves `run.json` reading `awaiting_input` and
 * the decision reading `pending`, and anyone holding the resume token — including the
 * reviewer who was asked before the cancel — can still redeem it and run the batch.
 * Before ses_017 the pause path terminalized the run, so this was unreachable; the
 * guard was removed and its replacement was never wired up.
 *
 * Two writes, in this order:
 *
 *   1. **Every open decision on the run is cancelled first.** A decision is what a token
 *      redeems against, so closing it before the run's status is what makes the window
 *      between the two writes safe rather than merely short: a redemption landing inside
 *      that window finds a `cancelled` decision and is refused, instead of finding a
 *      still-`pending` one on a run that has not yet been marked.
 *   2. **The run's persisted status becomes `cancelled`**, which is the structural
 *      refusal {@link resumeDecision} checks first, and the one that does not depend on
 *      anybody having remembered step 1.
 *
 * A decision already `resolved` or `executing` is left alone (see {@link cancelDecision}).
 * Idempotent; a terminal run is reported, not rewritten.
 */
export async function cancelRun(locator: RunLocator): Promise<CancelRunOutcome> {
	const store = await storeFor(locator)

	const meta = await store.readRunMeta()
	if (!meta) {
		// No record to cancel. Reported as cancelled rather than as an error: a cancel is
		// a request for a run to not be running, and a run with no record is not running.
		return { status: 'cancelled', cancelledDecisions: [], alreadyTerminal: false }
	}
	if (isTerminalStatus(meta.status)) {
		return { status: meta.status, cancelledDecisions: [], alreadyTerminal: true }
	}

	const cancelled: CheckpointId[] = []
	for (const checkpoint of await store.listCheckpoints()) {
		if (checkpoint.pendingDecision?.state !== 'pending') continue
		const after = await cancelDecisionOn(store, checkpoint.id)
		if (after?.state === 'cancelled') cancelled.push(checkpoint.id)
	}

	await store.updateRunMeta((current) => ({
		...current,
		status: 'cancelled',
		endedAt: current.endedAt ?? Date.now(),
	}))

	locator.logger?.info('Run cancelled durably', {
		runId: locator.runId,
		cancelledDecisions: cancelled.length,
	})

	return { status: 'cancelled', cancelledDecisions: cancelled, alreadyTerminal: false }
}

/**
 * Is a run in the one state a resume may start from? Exposed so callers that hold a
 * `Run` rather than a store can ask the same question {@link resumeDecision} asks.
 */
export function isResumableStatus(status: AgentStatus): boolean {
	return status === 'awaiting_input'
}
