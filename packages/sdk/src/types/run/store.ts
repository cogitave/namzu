/**
 * RunStore — persistence contract for a run's own evidence.
 *
 * The checkpoint store got an injectable seam and this did not, which left
 * the run record, its messages, its transcript and its report reachable only
 * through a concrete filesystem class. For a kernel whose stated purpose is
 * auditable evidence, the evidence was the one thing that could not be
 * pointed at durable storage: on ephemeral infrastructure the transcript dies
 * with the container, and behind a load balancer two replicas write two
 * disjoint run trees for one tenant.
 *
 * The location was already injectable through a path builder — but that
 * returns filesystem path strings, so it relocates the directory without
 * changing the medium.
 *
 * ## Bound to one run, unlike {@link CheckpointStore}
 *
 * Every accessor here addresses the run the store was bound to by
 * {@link RunStore.initRun}, where a `CheckpointStore` takes an explicit scope
 * per call. That asymmetry is inherited rather than chosen: this contract is
 * extracted from a class the runtime already constructs per run and holds for
 * the run's lifetime, and re-keying it would change every call site in the
 * same change that introduces the seam — two risks where one will do.
 *
 * A host implementing a shared backend therefore keys its rows by the
 * attribution it was constructed with plus the bound run id. If this is later
 * re-keyed per call, it happens once, deliberately, as its own change.
 */

import type { Run } from './entity.js'
import type { PersistedRunEvent, RunEvent } from './events.js'

/** What a caller asks the log for. See {@link RunStore.readEvents}. */
export interface ReadRunEventsOptions {
	/**
	 * Return only events ABOVE this sequence — strictly greater, never equal.
	 *
	 * The exclusive boundary is what makes a cursor round-trip: a consumer that
	 * last saw `seq: 12` passes 12 and receives 13 onward, so nothing is
	 * delivered twice. Absent means the whole log.
	 */
	readonly sinceSeq?: number
}

/**
 * One finished tool call, recovered from the run's own transcript.
 *
 * Re-declared here rather than imported from the disk store so the contract
 * does not depend on an implementation of itself.
 */
export interface CompletedToolRecord {
	readonly toolUseId: string
	readonly toolName: string
	readonly result: string
	readonly isError: boolean
}

export interface RunStore {
	/**
	 * Bind this store to a run, before any other call.
	 *
	 * Returns a location when the backend has one — the built-in disk store
	 * returns the run's directory — and `null` when it does not. A caller
	 * that renders the value must treat `null` as "this run is not on a
	 * filesystem" rather than as an error: an in-memory or object-storage
	 * backend has nothing to print, and inventing a path for it would put a
	 * directory that does not exist in front of an operator.
	 */
	initRun(runId: string, parentRunId?: string): Promise<string | null>

	/** Persist the run record: status, metadata, usage, timings. */
	writeRunMeta(run: Run): Promise<void>

	/** Persist the run's full message history. */
	writeMessages(run: Run): Promise<void>

	/**
	 * Append one event to the run's durable event log.
	 *
	 * High-frequency streaming deltas are excluded before they reach here —
	 * that exclusion is a deliberate trade and belongs to the emitter, not to
	 * the backend, so a store must not re-filter.
	 */
	appendEvent(event: RunEvent): Promise<void>

	/**
	 * Read the run's durable event log back, oldest first.
	 *
	 * Required, unlike {@link RunStore.addToIndex}, and the asymmetry is the
	 * point: a store that records a transcript it cannot read back is
	 * write-only evidence, which is the defect the whole contract exists to
	 * fix one level up. It is also what a reconnecting consumer catches up
	 * through — "refresh the page and keep watching the answer arrive" is this
	 * method plus a cursor and nothing else.
	 *
	 * Three obligations, each of which a consumer relies on:
	 *
	 *  1. **Ascending by `seq`, in the order the events were appended.** Do not
	 *     sort a log back into order — a log that needs sorting was written by
	 *     two processes, and hiding that produces a plausible transcript of a
	 *     run that never happened.
	 *  2. **`sinceSeq` is exclusive.** See {@link ReadRunEventsOptions}.
	 *  3. **Contiguous, or honestly short.** A backend that prunes may return a
	 *     first event above `sinceSeq + 1`; that is a gap, the caller detects
	 *     it, and the reconnect is refused rather than spliced. Do NOT
	 *     manufacture placeholders to close it.
	 *
	 * High-frequency events never enter the log (see
	 * {@link RunStore.appendEvent}), so what a late subscriber recovers is
	 * message-granular, not keystroke-granular. Aggregated assistant text,
	 * every tool result and the full message list are all intact; the deltas
	 * that composed them are not, and are not meant to be.
	 */
	readEvents(options?: ReadRunEventsOptions): Promise<readonly PersistedRunEvent[]>

	/**
	 * Persist the run's final report. Returns a location, or `null` when the
	 * backend has none. See {@link RunStore.initRun}.
	 */
	writeReport(content: string): Promise<string | null>

	/**
	 * Every tool call this run has already finished, keyed by `toolUseId`.
	 *
	 * A batch's results reach the message history only once the WHOLE batch
	 * settles, so a hard kill part-way through loses every result that had
	 * already come back, and the resumed run re-executes those calls. For a
	 * file write that is waste; for a payment or an email it is a second one.
	 *
	 * A backend that does not retain individual events answers with an empty
	 * map, which costs re-execution and is honest. It must not answer with a
	 * PARTIAL map: a caller reads a present entry as "this call is already
	 * answered", so a half-remembered batch is worse than a forgotten one.
	 */
	readCompletedTools(): Promise<Map<string, CompletedToolRecord>>

	/**
	 * Where this run's evidence lives, or `null` when it is not on a
	 * filesystem. Valid only after {@link RunStore.initRun}.
	 */
	getRunDir(): string | null

	/**
	 * Record the run in a browsable catalogue of runs. OPTIONAL.
	 *
	 * Optional because it is the one method here that is not evidence: it
	 * maintains a convenience listing for a human reading the directory, and
	 * a backend whose runs are already queryable has nothing to add. The
	 * programmatic answer to "which runs are there" is
	 * `CheckpointStore.listDurableRuns`, which carries attribution and
	 * includes sub-runs; this does neither.
	 */
	addToIndex?(run: Run): Promise<void>
}
