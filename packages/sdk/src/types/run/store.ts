import type { RunEvidenceScope, RunTextEvidenceSource } from '../../store/evidence/types.js'
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

import type { RunExecutionStatus } from '../common/index.js'
import type { Message } from '../message/index.js'
import type { AuditEvent } from './audit.js'
import type { Run } from './entity.js'
import type { PersistedRunEvent, RunEvent } from './events.js'

/**
 * The run's surviving message history, and whether it can be placed against
 * the durable event log without guessing.
 *
 * `available` is stronger than "some bytes were found": `throughEventSeq`
 * names the exact event-log head the snapshot was published after. A caller
 * can therefore refuse a stale snapshot left by an earlier pause or a crash
 * during final persistence instead of presenting it as the whole run.
 *
 * `legacy-unverified` preserves read access to the raw message arrays written
 * before snapshots carried that boundary. Those messages are real, but no
 * stored fact proves which event-log head they represent, so they must not be
 * used to claim a complete transcript.
 */
export type RunMessageSnapshot =
	| {
			readonly kind: 'available'
			readonly throughEventSeq: number
			readonly messages: readonly Message[]
	  }
	| {
			readonly kind: 'legacy-unverified'
			readonly messages: readonly Message[]
	  }
	| {
			readonly kind: 'unavailable'
			readonly reason: 'not-persisted'
	  }

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
	/**
	 * Refuse a disk transcript with a torn, malformed, or discontinuously
	 * numbered record instead of skipping past it.
	 *
	 * The default stays `tolerant`: an incident viewer is usually better served
	 * by every intact event around one damaged line. A caller making a
	 * completeness claim — an export, a replay proof, an archive — chooses
	 * `strict`, because one skipped line makes that claim false even when the
	 * rest of the log remains useful.
	 */
	readonly integrity?: 'tolerant' | 'strict'
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

/** The latest recorded execution boundary of a tool call, not its inferred external effect. */
export type ToolExecutionRecord =
	| (CompletedToolRecord & { readonly status: 'completed' })
	| { readonly toolUseId: string; readonly toolName: string; readonly status: 'started' }

/**
 * One delegated child run found on disk under its parent's `children/`
 * directory, as {@link import('../../store/run/disk.js').RunDiskStore.listChildren}
 * reports it.
 *
 * A DISCOVERY record, not the child's evidence: every field here comes from
 * the child's `run.json`, and the transcript, message snapshot and report
 * beside it stay on disk until something asks for them. {@link dir} is what
 * that something reads from.
 *
 * Everything the file supplies is optional, because a `run.json` is written
 * by the child's own terminal path and a process killed before it got there
 * leaves a directory whose other evidence is still worth opening. An absent
 * field is "this file did not say", never a zero or an empty string.
 */
export interface DelegatedChildRun {
	/**
	 * The child's run id, taken from the directory name.
	 *
	 * The location is the fact: `initRun` names the directory after the run
	 * it binds, so a `run.json` whose `id` disagrees with its own directory
	 * was moved or hand-edited, and the directory is the half that decides
	 * where the evidence actually is.
	 */
	readonly id: string
	/** The parent run whose `children/` directory holds this one. */
	readonly parentRunId: string
	/** Absolute path to the child's evidence directory. */
	readonly dir: string
	readonly agentId?: string
	readonly agentName?: string
	/** `metadata.config.model` — the model the child was configured with. */
	readonly model?: string
	readonly status?: RunExecutionStatus
	readonly startedAt?: number
	readonly endedAt?: number
	/** `tokenUsage.totalTokens` — this child's own cumulative spend. */
	readonly totalTokens?: number
	readonly depth?: number
}

/** Absence proves no recorded start only when the whole selected log is complete. */
export interface ToolExecutionSnapshot {
	readonly complete: boolean
	readonly records: ReadonlyMap<string, ToolExecutionRecord>
}

export interface RunStore {
	/**
	 * Optional bounded recovery scan for selected call IDs. A started call without
	 * a completion has an unknown outcome and must not be automatically replayed.
	 * The runtime falls back to strict readEvents for stores without this method.
	 */
	readToolExecutions?(
		toolUseIds: readonly string[],
		signal?: AbortSignal,
	): Promise<ToolExecutionSnapshot>
	/**
	 * Optional bounded read capability anchored to this writer's completed event
	 * boundary. Observe signal while waiting/reading; cancellation must not release
	 * a writer lock before its pending operation settles.
	 */
	captureTextEvidence?(
		scope: RunEvidenceScope,
		maxReadBytes?: number,
		signal?: AbortSignal,
	): Promise<RunTextEvidenceSource | undefined>

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

	/**
	 * Publish the run's surviving message history through a durable event.
	 *
	 * The boundary is required. Messages are written after the terminal or
	 * pause event, and a resumed run reuses the same run id; without the
	 * boundary an older, valid file is indistinguishable from the current
	 * run's final snapshot.
	 */
	writeMessages(run: Run, throughEventSeq: number): Promise<void>

	/**
	 * Read the published message snapshot back.
	 *
	 * Missing data is `unavailable`, never an available empty list. An empty
	 * list is a real snapshot only after {@link RunStore.writeMessages}
	 * explicitly published it. This distinction closes the crash window where
	 * the run's terminal event and metadata landed but its messages did not.
	 */
	readMessages(): Promise<RunMessageSnapshot>

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
	 * This completed-only view cannot distinguish an unstarted call from an
	 * interrupted effect. It is not authority to execute an absent call. Runtime
	 * recovery uses readToolExecutions or a strict readEvents scan instead.
	 */
	readCompletedTools(): Promise<Map<string, CompletedToolRecord>>

	/**
	 * Where this run's evidence lives, or `null` when it is not on a
	 * filesystem. Valid only after {@link RunStore.initRun}.
	 */
	getRunDir(): string | null

	/**
	 * Append one entry to this run's AUDIT trail. OPTIONAL on the contract,
	 * the same way {@link RunStore.addToIndex} is — an existing custom
	 * `RunStore` keeps compiling without it. Unlike `addToIndex`, though, its
	 * absence is not a shrug:
	 * {@link import('../../manager/run/persistence.js').RunPersistence.recordAudit}
	 * REFUSES rather than silently running a bound store that lacks it, per
	 * `refuse-do-not-degrade` — an audit trail nobody can point at is not a
	 * degraded feature, it is the kernel's central claim quietly not being
	 * true. NOTE: because `recordAudit` is called from every run's terminal
	 * path, a `RunStore` implementer that adopts this contract without also
	 * implementing this method will see every run throw. See the major-bump
	 * changeset.
	 *
	 * A SEPARATE trail from {@link RunStore.appendEvent}: an operational log
	 * is level-filtered, sampled, rotatable and legitimately absent when no
	 * host installed a sink. None of that is acceptable for evidence of what
	 * an agent did, under whose identity, at what cost, and whether it was
	 * allowed — see `types/run/audit.ts` for the full reasoning (ses_020's
	 * logging design §5).
	 *
	 * A write that rejects here must fail the caller's operation. This is the
	 * one place on this whole contract where that is true — every other write
	 * here may be retried or reported by a caller that chooses to; this one
	 * is durability's last line, and a caller that catches and continues past
	 * a rejection here has silently degraded the audit trail into decoration.
	 */
	appendAuditEvent?(event: AuditEvent): Promise<void>

	/**
	 * Read the run's audit trail back, oldest first. OPTIONAL for the same
	 * reason {@link RunStore.appendAuditEvent} is. What a resumed run seeds
	 * its next audit `seq` from, and the input to
	 * {@link import('./audit.js').replayRun}. See {@link RunStore.readEvents}
	 * for the ordering and gap obligations — the same three apply here,
	 * against this trail's own sequence space.
	 */
	readAuditEvents?(): Promise<readonly AuditEvent[]>

	/**
	 * Record the run in a browsable catalogue of runs. OPTIONAL.
	 *
	 * Optional because it is the one method here that is not evidence: it
	 * maintains a convenience listing for a human reading the directory, and
	 * a backend whose runs are already queryable has nothing to add. The
	 * programmatic answer to "which runs are there" is
	 * `CheckpointStore.listDurableRuns`, which carries attribution and
	 * includes sub-runs; this does neither.
	 *
	 * @deprecated The kernel no longer calls it: the disk store's catalogue
	 *   (`index.json`) repeated what every run's `run.json` already records,
	 *   and `RunDiskStore.listRuns` now reads those, falling back to a
	 *   catalogue an earlier version left only for runs no run record
	 *   describes. Removed in a later major.
	 */
	addToIndex?(run: Run): Promise<void>
}
