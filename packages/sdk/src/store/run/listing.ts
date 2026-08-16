/**
 * Shared machinery for {@link CheckpointStore.listDurableRuns}.
 *
 * Every rule the listing promises — the contiguous-prefix refusal, the park
 * precedence, the ordering, the paging — lives here and is used by BOTH
 * shipped implementations. A rule implemented twice is a rule that holds in
 * one store and not the other, and the whole point of a store contract is
 * that a host can swap the backend without swapping the semantics.
 */

import { NamzuError } from '../../types/errors/index.js'
import type { IterationCheckpoint, PendingDecision } from '../../types/hitl/index.js'
import type {
	CheckpointListingScope,
	CheckpointRunScope,
	CheckpointStore,
	ClaimRunOptions,
	DurableRunEntry,
	DurableRunOrder,
	DurableRunPage,
	FencingToken,
	LeaseSummary,
	ListDurableRunsOptions,
	ParkState,
	ParkSummary,
	RunLease,
} from '../../types/run/checkpoint-store.js'

/** Page size when the caller names none. */
export const DEFAULT_DURABLE_RUN_LIMIT = 100

/**
 * Refuse a listing scope with a hole in it.
 *
 * `{ tenantId, sessionId }` reads as "that session under whichever project
 * holds it". A flat backend can answer it; a hierarchical one cannot look up
 * a session without its project. Answering differently per backend is the
 * one thing the contract exists to prevent, so neither answers: the caller
 * names the project it means.
 */
export function assertContiguousListingScope(scope: CheckpointListingScope, caller: string): void {
	if (scope.sessionId !== undefined && scope.projectId === undefined) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `${caller}: listing scope has a hole — \`sessionId\` was supplied without \`projectId\`. A run listing scope is a contiguous prefix of tenant → project → session; name the project the session belongs to.`,
			details: { tenantId: scope.tenantId, sessionId: scope.sessionId },
		})
	}
}

/** Whether a park's absolute deadline has passed. No deadline never expires. */
function isPastDeadline(pending: PendingDecision, now: number): boolean {
	return pending.deadlineAt !== undefined && now >= pending.deadlineAt
}

/**
 * Which of the three states a recorded park is in.
 *
 * `resolved` is checked FIRST: a park that was answered after its deadline
 * passed is answered, not expired. Reading the deadline first would report
 * a decision a human actually made as an expiry nobody made, and the
 * checkpoint is the evidence record for exactly that question.
 */
function parkStateOf(pending: PendingDecision, now: number): ParkState {
	if (pending.resolvedAt !== undefined) return 'resolved'
	return isPastDeadline(pending, now) ? 'expired' : 'outstanding'
}

function toParkSummary(
	cp: IterationCheckpoint,
	pending: PendingDecision,
	now: number,
): ParkSummary {
	return {
		state: parkStateOf(pending, now),
		checkpointId: cp.id,
		requestType: pending.request.type,
		parkedAt: pending.parkedAt,
		...(pending.deadlineAt !== undefined ? { deadlineAt: pending.deadlineAt } : {}),
		...(pending.resolvedAt !== undefined ? { resolvedAt: pending.resolvedAt } : {}),
	}
}

/**
 * The one park that describes what a run is doing now, out of every park it
 * ever recorded.
 *
 * Precedence: newest `outstanding`, else newest `expired`, else newest
 * `resolved`.
 *
 * `outstanding` wins because that is the question an inbox is asking, and
 * because the answer has to be the SAME checkpoint `findPendingCheckpoint`
 * returns. A run can hold several parks — it parks, a human answers, it runs
 * on, it parks again — and it can hold an outstanding one that is older than
 * a resolved one only in the reverse case, where an earlier park expired
 * unanswered and the run was resumed past it. Ranking by recency alone would
 * then hand an inbox a resolved checkpoint and report the live park as
 * nothing.
 *
 * @param checkpoints the run's checkpoints, any order.
 */
export function summarizePark(
	checkpoints: readonly IterationCheckpoint[],
	now: number,
): ParkSummary | undefined {
	let best: ParkSummary | undefined
	let bestRank = -1
	let bestParkedAt = Number.NEGATIVE_INFINITY

	for (const cp of checkpoints) {
		const pending = cp.pending
		if (!pending) continue
		const summary = toParkSummary(cp, pending, now)
		const rank = PARK_RANK[summary.state]
		if (rank > bestRank || (rank === bestRank && pending.parkedAt > bestParkedAt)) {
			best = summary
			bestRank = rank
			bestParkedAt = pending.parkedAt
		}
	}

	return best
}

const PARK_RANK: Record<ParkState, number> = {
	resolved: 0,
	expired: 1,
	outstanding: 2,
}

/**
 * Project one run's checkpoints into a listing entry.
 *
 * Returns `null` for a run with no checkpoints: the listing is of runs with
 * DURABLE state, and a run with nothing stored has nothing a sweeper could
 * resume. A disk walk hits this case for real — a sub-run's directory is
 * created as a bare shell under its own id before anything is written to it.
 */
export function toDurableRunEntry(
	scope: CheckpointRunScope,
	checkpoints: readonly IterationCheckpoint[],
	now: number,
): DurableRunEntry | null {
	if (checkpoints.length === 0) return null

	let latest = checkpoints[0] as IterationCheckpoint
	// The EARLIEST recorded stamp, not the one on any particular checkpoint.
	// Every checkpoint of a run carries the same value, so under that
	// invariant the minimum is that value. Taking the minimum rather than
	// reading one checkpoint is what makes the read safe if the invariant is
	// ever broken: it can only err toward the run's true attribution, never
	// away from it, and it cannot move when a later checkpoint is added.
	let runCreatedAt: number | undefined
	for (const cp of checkpoints) {
		if (cp.createdAt > latest.createdAt) latest = cp
		if (
			cp.runCreatedAt !== undefined &&
			(runCreatedAt === undefined || cp.runCreatedAt < runCreatedAt)
		) {
			runCreatedAt = cp.runCreatedAt
		}
	}

	const park = summarizePark(checkpoints, now)

	return {
		tenantId: scope.tenantId,
		projectId: scope.projectId,
		sessionId: scope.sessionId,
		runId: scope.runId,
		...(scope.parentRunId ? { parentRunId: scope.parentRunId } : {}),
		...(runCreatedAt !== undefined ? { runCreatedAt } : {}),
		checkpointCount: checkpoints.length,
		latestCheckpointId: latest.id,
		latestCheckpointAt: latest.createdAt,
		...(park ? { park } : {}),
	}
}

/**
 * Apply the park filter, the contract's ordering and the cursor to a set of
 * entries an implementation has gathered.
 *
 * Both shipped stores gather differently — one walks a directory tree, one
 * reads a map — and then hand the result here, so "ordered by `runId`, page
 * ends where the next begins" is one implementation rather than two.
 */
export function paginateDurableRuns(
	entries: readonly DurableRunEntry[],
	options?: ListDurableRunsOptions,
): DurableRunPage {
	const wanted = options?.park
	const byPark =
		wanted && wanted.length > 0
			? entries.filter((e) => e.park !== undefined && wanted.includes(e.park.state))
			: entries

	// An expired claim counts as unheld. That is what expiry means, and a
	// queue reader that treated an expired claim as held would leave a dead
	// worker's runs invisible forever — the exact failure a lease exists to
	// prevent, reintroduced by the filter that reads it.
	const filtered =
		options?.claimed === undefined
			? byPark
			: byPark.filter((e) => (e.claim !== undefined && !e.claim.expired) === options.claimed)

	// Both orders sort on a key that cannot move under a paging caller — see
	// the contract comment on `listDurableRuns`.
	const orderBy = options?.orderBy ?? 'runId'
	const ordered = [...filtered].sort((a, b) =>
		compareKeys(sortKey(a, orderBy), sortKey(b, orderBy)),
	)

	const after = options?.cursor === undefined ? undefined : decodeCursor(options.cursor, orderBy)
	const start =
		after === undefined ? 0 : ordered.findIndex((e) => compareKeys(sortKey(e, orderBy), after) > 0)
	const from = start < 0 ? ordered.length : start

	const limit = Math.max(1, Math.trunc(options?.limit ?? DEFAULT_DURABLE_RUN_LIMIT))
	const page = ordered.slice(from, from + limit)
	const exhausted = from + page.length >= ordered.length

	return {
		entries: page,
		// No cursor when there is nothing behind it, so `while (cursor)`
		// terminates rather than fetching one empty page to find out.
		...(exhausted || page.length === 0
			? {}
			: { cursor: encodeCursor(sortKey(page[page.length - 1] as DurableRunEntry, orderBy)) }),
	}
}

/**
 * A row's position in the requested order, as a comparable tuple.
 *
 * The first element is a rank rather than the timestamp itself, so that
 * "never recorded" is a position in its own right instead of a number
 * standing in for one. In `createdAt` order it ranks 0 and everything
 * stamped ranks 1 — unrecorded runs first, and truthfully so: the stamp is
 * written by the checkpoint manager, so a run without one was checkpointed
 * by a build that predates it, and predates every run that has one.
 */
type SortKey = readonly [number, number, string]

function sortKey(entry: DurableRunEntry, orderBy: DurableRunOrder): SortKey {
	if (orderBy === 'runId') return [0, 0, entry.runId]
	return entry.runCreatedAt === undefined
		? [0, 0, entry.runId]
		: [1, entry.runCreatedAt, entry.runId]
}

function compareKeys(a: SortKey, b: SortKey): number {
	if (a[0] !== b[0]) return a[0] - b[0]
	if (a[1] !== b[1]) return a[1] - b[1]
	return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0
}

/**
 * The cursor is the last row's key, and nothing else.
 *
 * Opaque to callers by contract — the shape is written down here rather than
 * in the type so a host is not tempted to construct one. Run ids come from a
 * 36-character lowercase alphabet with a `run_` prefix and contain no
 * separator, so joining on `:` is unambiguous.
 */
function encodeCursor(key: SortKey): string {
	return `${key[0]}:${key[1]}:${key[2]}`
}

function decodeCursor(cursor: string, orderBy: DurableRunOrder): SortKey {
	const first = cursor.indexOf(':')
	const second = cursor.indexOf(':', first + 1)
	if (first < 0 || second < 0) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `listDurableRuns: "${cursor}" is not a cursor this listing issued. Pass back the \`cursor\` from the previous page rather than constructing one; its shape is not part of the contract.`,
			details: { cursor, orderBy },
		})
	}
	const rank = Number(cursor.slice(0, first))
	const stamp = Number(cursor.slice(first + 1, second))
	if (!Number.isFinite(rank) || !Number.isFinite(stamp)) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `listDurableRuns: cursor "${cursor}" is malformed — its position fields are not numbers. Pass back the \`cursor\` from the previous page.`,
			details: { cursor, orderBy },
		})
	}
	return [rank, stamp, cursor.slice(second + 1)]
}

/**
 * Every run with durable state under a scope, refusing when the store cannot
 * answer.
 *
 * The refusal is the point. `listDurableRuns` is optional on the contract so
 * that adding it did not break every host that had already implemented the
 * interface — and an optional capability reached without a check degrades
 * into a wrong answer: a store that cannot list would hand an approval inbox
 * an empty page, and "nothing is waiting on a human" is not what "I cannot
 * tell" means. A host that gets this error knows to supply a backend that
 * implements the listing; a host that got `[]` would ship an inbox that
 * silently never fires.
 */
export async function listDurableRuns(
	store: CheckpointStore,
	scope: CheckpointListingScope,
	options?: ListDurableRunsOptions,
): Promise<DurableRunPage> {
	if (typeof store.listDurableRuns !== 'function') {
		throw new NamzuError({
			code: 'capability_unavailable',
			message:
				'listDurableRuns: the injected checkpoint store does not implement `listDurableRuns`, so it cannot enumerate runs above a run id. Refusing rather than reporting an empty listing, which would read as "no runs are parked" when the truth is that this store cannot tell. Supply a store that implements it (the built-in disk and in-memory stores both do).',
			details: { tenantId: scope.tenantId },
		})
	}
	assertContiguousListingScope(scope, 'listDurableRuns')
	return store.listDurableRuns(scope, options)
}

/**
 * Take working possession of a run, refusing when the store cannot arbitrate.
 *
 * The refusal is the entire safety property. `claimRun` is optional on the
 * contract, and the natural way to reach an absent optional method is to skip
 * it — which here means every worker proceeds, believing it holds a run
 * nobody arbitrated. Two workers then restore the same checkpoint, both run
 * the tools, and both write under one run id; half the work vanishes with no
 * error anywhere.
 *
 * So a store with no claim support does not get "claimed by default". It gets
 * an error naming the deployment shape it cannot support. A single-writer
 * host never calls this and is unaffected.
 *
 * Returns `null` — not an error — when another holder has the run. That is
 * the ordinary outcome of two readers on one queue, and a caller loops to the
 * next run rather than handling a fault.
 */
export async function claimRun(
	store: CheckpointStore,
	scope: CheckpointRunScope,
	options: ClaimRunOptions,
): Promise<RunLease | null> {
	if (typeof store.claimRun !== 'function') {
		throw new NamzuError({
			code: 'capability_unavailable',
			message:
				'claimRun: the injected checkpoint store does not implement `claimRun`, so it cannot arbitrate between two workers taking the same run. Refusing rather than proceeding unclaimed — proceeding would let two workers restore one checkpoint, both execute its tools, and both write under one run id, which loses half the work and reports nothing. Supply a store that implements it, or run a single writer per run.',
			details: { runId: scope.runId },
		})
	}
	if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `claimRun: ttlMs must be a positive number of milliseconds, got ${String(options.ttlMs)}. A lease that expires immediately is a lease every worker can take at once, which is the condition this call exists to prevent.`,
			details: { runId: scope.runId, ttlMs: options.ttlMs },
		})
	}
	return store.claimRun(scope, options)
}

/**
 * Give a claim up early, refusing when the store cannot arbitrate.
 *
 * Refuses for the same reason as {@link claimRun}: a host that believes it is
 * releasing a claim on a store that has none is a host that believes the
 * whole mechanism is running.
 */
export async function releaseRun(
	store: CheckpointStore,
	scope: CheckpointRunScope,
	fence: FencingToken,
): Promise<void> {
	if (typeof store.releaseRun !== 'function') {
		throw new NamzuError({
			code: 'capability_unavailable',
			message:
				'releaseRun: the injected checkpoint store does not implement `releaseRun`. A release that silently does nothing would leave the run held until its lease expires while the caller believes it is back on the queue.',
			details: { runId: scope.runId },
		})
	}
	return store.releaseRun(scope, fence)
}

/**
 * The refusal a store raises when a write presents a superseded fence.
 *
 * Shared so both shipped stores say the same thing, and so a host writing its
 * own backend raises something a caller can branch on rather than a message
 * string. This is the moment a stalled worker learns it lost the run — the
 * only moment it CAN learn, since from the inside a pause and a partition
 * both look like time not passing.
 */
export function fencedOut(
	scope: CheckpointRunScope,
	presented: number,
	current: number,
): NamzuError {
	return new NamzuError({
		code: 'storage_error',
		message: `writeCheckpoint: refusing a write for run ${scope.runId} fenced at ${presented} — the run is now claimed at ${current}. Another worker took this run over, so this process no longer holds it and its work is not the record. Stop the run rather than retrying: the claim is gone, not busy.`,
		details: { runId: scope.runId, presentedFence: presented, currentFence: current },
		retryable: false,
	})
}

/**
 * Whether a recorded claim still holds at `now`, and the summary a listing
 * reports for it.
 */
export function toClaimSummary(claim: RunLease, now: number): LeaseSummary {
	return {
		holder: claim.holder,
		fence: claim.fence,
		expiresAt: claim.expiresAt,
		// Judged here, once, against the store's clock. Left to the caller it
		// would be judged against a different one, and a single page could
		// then disagree with itself about which rows are available.
		expired: now >= claim.expiresAt,
	}
}
