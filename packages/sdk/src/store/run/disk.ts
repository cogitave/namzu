import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunExecutionStatus } from '../../types/common/index.js'
import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { Message } from '../../types/message/index.js'
import type {
	AuditEvent,
	PersistedRunEvent,
	Run,
	RunEvent,
	RunStoreConfig,
} from '../../types/run/index.js'
import type {
	CompletedToolRecord,
	DelegatedChildRun,
	ReadRunEventsOptions,
	RunMessageSnapshot,
	RunStore,
} from '../../types/run/store.js'
import { atomicWriteFile, durableWriteFile } from '../../utils/atomic-write.js'
import { awaitWithAbort } from '../../utils/await-with-abort.js'
import { asCheckpointId, asRunId, isEntityId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { restoreCompactionRecord, retainCompactionRecord } from '../evidence/compaction-archive.js'
import { digest } from '../evidence/format.js'
import { createLinkedRunTextEvidenceSource } from '../evidence/linked.js'
import {
	type RecordPointer,
	hasEvidenceText,
	recordPointerSchema,
	transcriptTail,
} from '../evidence/record-chain.js'
import type { RunEvidenceScope, RunTextEvidenceSource } from '../evidence/types.js'
import { defineSchema, migrate, stamp } from '../schema.js'
import { selectCheckpointsToPrune } from './prune.js'
import {
	type RunHistoryCompaction,
	type RunHistoryRef,
	RunHistoryRefusal,
	type RunHistoryRoot,
	type RunHistorySource,
	RunHistoryWriter,
	compactRunHistoryLocked,
	isRunHistoryRef,
	loadRunHistory,
	openRunHistory,
	resolveRunHistory,
	withRunHistoryLock,
} from './run-history.js'
import { readToolExecutionsIn } from './tool-executions.js'

/**
 * This store's on-disk format, versioned as a unit — which is how a
 * migration would actually be written and shipped, and it keeps every call
 * site free of schema plumbing.
 *
 * Bump `current` and add the migration for the step you are leaving when
 * the shape changes.
 */
const SCHEMA = defineSchema({ kind: 'run-store', current: 1, migrations: {} })
// Older readers must refuse ledger-bound checkpoints instead of dropping their
// budget authority. Other run-store records retain their existing schema.
//
// Version 3 moves a checkpoint's messages into the run's history log (see
// `run-history.ts`) and stores a reference in their place.
// Earlier records carry `messages` inline and are read as they always were;
// a build that predates version 3 refuses a version-3 file rather than read
// one with no messages.
const CHECKPOINT_SCHEMA = defineSchema({
	kind: 'run-checkpoint',
	current: 3,
	migrations: { 1: (record) => record, 2: (record) => record },
})

/**
 * `messages.json` since the run history log: the event boundary and a
 * reference into the log, in place of the messages themselves.
 */
const RUN_MESSAGE_SNAPSHOT_V2 = 'namzu.run-message-snapshot.v2'

/**
 * One finished tool call, recovered from the transcript.
 *
 * Re-exported from the store contract rather than declared twice. Two
 * declarations of one concept, each populated by its own mapper, is the shape
 * this repository has a rule about.
 */
export type { CompletedToolRecord }

export class RunDiskStore implements RunStore {
	async readToolExecutions(ids: readonly string[], signal?: AbortSignal) {
		return readToolExecutionsIn(
			join(this.requireInit(), 'transcript.jsonl'),
			this.boundRunId!,
			ids,
			signal,
		)
	}
	private baseDir: string
	private runDir: string | null = null
	private log: Logger
	private eventLock: Promise<void> = Promise.resolve()
	private evidenceTip: RecordPointer | undefined
	private evidenceTextTip: RecordPointer | null | undefined
	private evidenceEpoch = randomUUID()
	private boundRunId: string | undefined
	private indexLock: Promise<void> = Promise.resolve()
	private history: RunHistoryWriter | undefined

	constructor(config: RunStoreConfig) {
		this.baseDir = config.baseDir
		this.log = resolveLogger(config.logger).child({
			[SCOPE_ATTRIBUTE]: 'store/run/disk',
		})
	}

	private requireInit(): string {
		if (!this.runDir) {
			throw new Error('RunDiskStore not initialized — call initRun() first')
		}
		return this.runDir
	}

	async initRun(runId: string, parentRunId?: string): Promise<string> {
		asRunId(runId)
		if (parentRunId !== undefined) asRunId(parentRunId)
		if (parentRunId) {
			this.runDir = join(this.baseDir, parentRunId, 'children', runId)
		} else {
			this.runDir = join(this.baseDir, runId)
		}
		await mkdir(this.runDir, { recursive: true })
		await healTornTranscript(this.runDir)
		await healTornAuditTrail(this.runDir)
		this.boundRunId = runId
		this.history = undefined
		this.evidenceEpoch = randomUUID()
		const tail = await transcriptTail(join(this.runDir, 'transcript.jsonl'), runId)
		this.evidenceTip = tail?.tip
		this.evidenceTextTip = tail?.textTip
		this.log.info('Run directory created', { 'namzu.run.dir': this.runDir })
		return this.runDir
	}

	private withEventLock<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.eventLock.then(operation)
		this.eventLock = next.then(
			() => {},
			() => {},
		)
		return next
	}

	async appendEvent(event: RunEvent): Promise<void> {
		return this.withEventLock(async () => {
			const storedEvent = await retainCompactionRecord(event, this.requireInit())
			const path = join(this.requireInit(), 'transcript.jsonl')
			const before = await stat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return { size: 0 }
				throw error
			})
			const previous = this.evidenceTip
			const linked =
				event.runId === this.boundRunId &&
				previous &&
				previous.offset + previous.length === before.size &&
				previous.seq + 1 === event.seq
			const previousTextRecord = linked
				? this.evidenceTextTip
				: before.size === 0 && event.seq === 1 && event.type === 'run_started'
					? null
					: undefined
			const line = Buffer.from(
				`${JSON.stringify({
					...storedEvent,
					timestamp: Date.now(),
					previousRecord: linked ? previous : null,
					previousTextRecord,
				})}\n`,
			)
			await appendFile(path, line)
			const pointer = recordPointerSchema.safeParse({
				offset: before.size,
				length: line.length,
				sha256: digest(line),
				seq: event.seq,
			})
			this.evidenceTip =
				event.runId === this.boundRunId && pointer.success ? pointer.data : undefined
			// Include chain boundaries as well as text. This prevents a later skip
			// from hiding an incomplete history or a malformed content record.
			this.evidenceTextTip = this.evidenceTip
				? !linked || hasEvidenceText(JSON.parse(line.toString('utf8')))
					? this.evidenceTip
					: previousTextRecord
				: undefined
		})
	}

	/** Capture a writer-owned, immutable read boundary between complete appends. */
	async captureTextEvidence(
		scope: RunEvidenceScope,
		maxReadBytes?: number,
		signal?: AbortSignal,
	): Promise<RunTextEvidenceSource | undefined> {
		signal?.throwIfAborted()
		const capture = this.withEventLock(async () => {
			signal?.throwIfAborted()
			if (scope.runId !== this.boundRunId)
				throw new Error('Evidence capture does not own this run.')
			if (!this.evidenceTip) return undefined
			const runDir = this.requireInit()
			const before = await stat(join(runDir, 'transcript.jsonl'))
			signal?.throwIfAborted()
			const tip = { ...this.evidenceTip }
			if (before.size < tip.offset + tip.length)
				throw new Error('Evidence transcript was shortened.')
			return createLinkedRunTextEvidenceSource(
				{
					scope,
					runDir,
					indexDir: join(runDir, 'evidence-index'),
					maxReadBytes,
				},
				{
					tip,
					identity: `${before.dev}:${before.ino}`,
					epoch: this.evidenceEpoch,
				},
			)
		})
		return awaitWithAbort(capture, signal)
	}

	async readEvents(options?: ReadRunEventsOptions): Promise<readonly PersistedRunEvent[]> {
		return readRunEventsIn(this.requireInit(), options)
	}

	async readMessages(): Promise<RunMessageSnapshot> {
		return readRunMessagesIn(this.requireInit())
	}

	async appendAuditEvent(event: AuditEvent): Promise<void> {
		const dir = this.requireInit()
		// One JSON object per line, exactly like `transcript.jsonl` — but its
		// own file, on its own sequence space (`AuditEvent.seq`), because an
		// audit trail sharing bytes with an operational log inherits that
		// log's operational habits (rotation, truncation) whether or not
		// anyone intended them to apply here.
		await appendFile(join(dir, 'audit.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8')
	}

	async readAuditEvents(): Promise<readonly AuditEvent[]> {
		const dir = this.requireInit()
		let raw: string
		try {
			raw = await readFile(join(dir, 'audit.jsonl'), 'utf-8')
		} catch (err) {
			if (isFileNotFound(err)) return []
			throw err
		}

		const events: AuditEvent[] = []
		for (const line of raw.split('\n')) {
			if (line.length === 0) continue
			try {
				events.push(JSON.parse(line) as AuditEvent)
			} catch {
				// A torn last line is the normal shape of a file that was being
				// appended to when the process died — the same failure mode
				// `readRunEventsIn` skips past for `transcript.jsonl`, and for
				// the same reason: every whole line before it is still good,
				// and refusing the whole trail over one incomplete tail entry
				// would discard evidence the crash did not actually destroy.
				//
				// Deliberately empty: the skip IS the handling. There was a
				// `continue` here, which read as intent but sat last in the
				// loop body and did nothing.
			}
		}
		return events
	}

	/**
	 * Every tool call this run has already finished, keyed by `toolUseId`.
	 *
	 * A batch's results are pushed onto the history only once the WHOLE
	 * batch settles, so a hard kill part-way through loses every result
	 * that had already come back — and the resumed run re-executes those
	 * calls. For a `write_file` that is waste; for a payment or an email it
	 * is a second one.
	 *
	 * Nothing new has to be written to make that recoverable: the executor
	 * already awaits a `tool_completed` event per tool, inline, carrying the
	 * id, the name, the result and the error flag, and the transcript
	 * already persists it. The record was durable all along and simply
	 * never read back.
	 */
	async readCompletedTools(): Promise<Map<string, CompletedToolRecord>> {
		const dir = this.requireInit()
		const completed = new Map<string, CompletedToolRecord>()

		let raw: string
		try {
			raw = await readFile(join(dir, 'transcript.jsonl'), 'utf-8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return completed
			throw error
		}

		for (const line of raw.split('\n')) {
			if (line.length === 0) continue
			let event: Record<string, unknown>
			try {
				event = JSON.parse(line) as Record<string, unknown>
			} catch {
				// A torn last line is the normal shape of a file that was
				// being appended to when the process died — which is exactly
				// the case this method exists for. Skip it; every whole line
				// before it is still good.
				continue
			}
			if (event.type !== 'tool_completed') continue
			const toolUseId = event.toolUseId
			const toolName = event.toolName
			if (typeof toolUseId !== 'string' || typeof toolName !== 'string') continue

			// Last write wins: a retried tool emits one event per attempt and
			// the final one is what actually answered the call.
			completed.set(toolUseId, {
				toolUseId,
				toolName,
				result: typeof event.result === 'string' ? event.result : '',
				isError: event.isError === true,
			})
		}

		return completed
	}

	async writeRunMeta(run: Run): Promise<void> {
		const dir = this.requireInit()

		const meta: Record<string, unknown> = {
			id: run.id,
			status: run.status,
			metadata: run.metadata,
			tokenUsage: run.tokenUsage,
			budget: run.budget,
			budgetBinding: run.budgetBinding,
			currentIteration: run.currentIteration,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			lastError: run.lastError,
			messageCount: run.messages.length,
		}

		// The schema-validated answer belongs in the durable record for the same
		// reason `result` does: a run reloaded by id that has lost its answer has
		// lost the thing it was run for. Written only when present, so a run that
		// asked for no schema carries no key rather than an explicit `undefined`.
		if (run.structuredOutput !== undefined) meta.structuredOutput = run.structuredOutput

		if (run.parentRunId) meta.parentRunId = run.parentRunId
		if (run.depth !== undefined && run.depth > 0) meta.depth = run.depth

		await atomicWriteJson(join(dir, 'run.json'), meta)
	}

	/**
	 * Publish the history the run settled with.
	 *
	 * A reference into the run's history log (`namzu.run-message-snapshot.v2`),
	 * not a copy: by the time a run settles, its checkpoints have already put
	 * nearly every message in the log, and writing them into `messages.json`
	 * as well stored the conversation twice. {@link readRunMessagesIn} and
	 * {@link RunDiskStore.readMessages} resolve it; a v1 file with the
	 * messages inline still reads as it always did.
	 */
	async writeMessages(run: Run, throughEventSeq: number): Promise<void> {
		const dir = this.requireInit()
		await withRunHistoryLock(dir, async () => {
			const history = await this.historyWriter(dir).recordLocked(run.messages)
			await atomicWriteJson(join(dir, 'messages.json'), {
				format: RUN_MESSAGE_SNAPSHOT_V2,
				throughEventSeq,
				history,
			})
		})
	}

	private historyWriter(dir: string): RunHistoryWriter {
		this.history ??= new RunHistoryWriter(dir)
		return this.history
	}

	async writeReport(content: string): Promise<string> {
		const dir = this.requireInit()

		const reportPath = join(dir, 'report.md')
		await atomicWriteFile(reportPath, content)
		this.log.info('Report written', { 'namzu.run.report_path': reportPath })
		return reportPath
	}

	getRunDir(): string | null {
		return this.runDir
	}

	async writeCheckpoint(checkpoint: IterationCheckpoint): Promise<void> {
		asCheckpointId(checkpoint.id)
		const dir = this.requireInit()
		const cpDir = join(dir, 'checkpoints')
		await mkdir(cpDir, { recursive: true })
		// The history goes to the run's log, once per distinct message; the
		// checkpoint keeps a reference to it. See `run-history.ts`. Both happen
		// under the run's history lock, so a compaction never sees the append
		// without the file that references it.
		const { messages, ...rest } = checkpoint
		await withRunHistoryLock(dir, async () => {
			const history = await this.historyWriter(dir).recordLocked(messages)
			// Stamped, not written bare. Unstamped is read as version 1 by
			// definition, which is correct only while version 1 is the only
			// version there has ever been — the moment a second one exists, an
			// unstamped file written by the newer build is read by the older one
			// as if it were the older shape, and the refusal that exists to
			// prevent exactly that never fires. The stamp is what gives the
			// migration chain something to hang on.
			// Compact: a checkpoint is read by the store, not by a person, and at
			// one per iteration the indentation was a third of its bytes.
			await atomicWriteJson(
				join(cpDir, `${checkpoint.id}.json`),
				{ ...rest, history },
				CHECKPOINT_SCHEMA,
				'compact',
			)
		})
	}

	async readCheckpoint(checkpointId: CheckpointId): Promise<IterationCheckpoint | null> {
		asCheckpointId(checkpointId)
		const dir = this.requireInit()
		const path = join(dir, 'checkpoints', `${checkpointId}.json`)
		try {
			return await withRunHistoryLock(dir, () =>
				readRecordResolving(path, async (content) => {
					const history = openRunHistory(dir)
					try {
						return await parseCheckpoint(content, `${checkpointId}.json`, history)
					} finally {
						await history.close()
					}
				}),
			)
		} catch (err) {
			if (isFileNotFound(err)) return null
			throw err
		}
	}

	async listCheckpoints(): Promise<IterationCheckpoint[]> {
		return readCheckpointsIn(this.requireInit())
	}

	/**
	 * Collect old checkpoints until `keepLast` newer ones remain, then collect
	 * the history lines nothing references any more.
	 *
	 * The store-native form of `CheckpointManager.prune`, and the reason it
	 * exists: the generic form lists every checkpoint, which resolves every
	 * history against the log, on every iteration. This reads the checkpoint
	 * files alone — a few kilobytes each — so it neither re-reads the log nor
	 * refuses because one history in it is damaged. The same selection rule
	 * ({@link selectCheckpointsToPrune}): the newest `keepLast` and every
	 * unresolved park are kept.
	 *
	 * @returns what the history compaction found, for measurement.
	 */
	async pruneCheckpoints(
		keepLast: number,
		options: { readonly minReclaimBytes?: number } = {},
	): Promise<RunHistoryCompaction> {
		const dir = this.requireInit()
		// One read of each checkpoint file serves the selection and the
		// compaction check, under the lock so no write lands in between.
		return withRunHistoryLock(dir, async () => {
			const files = await readCheckpointFilesIn(dir)
			const doomed = new Set(
				selectCheckpointsToPrune(
					files.map((f) => f.header),
					keepLast,
				),
			)
			for (const id of doomed) await this.deleteCheckpoint(id)
			const survivors = files.filter((f) => !doomed.has(f.header.id))
			return compactRunHistoryLocked(
				dir,
				[...survivors.flatMap(checkpointRoot), ...(await snapshotRoot(dir))],
				options,
			)
		})
	}

	async deleteCheckpoint(checkpointId: CheckpointId): Promise<void> {
		asCheckpointId(checkpointId)
		const dir = this.requireInit()
		try {
			await unlink(join(dir, 'checkpoints', `${checkpointId}.json`))
		} catch (err) {
			if (!isFileNotFound(err)) throw err
		}
	}

	/**
	 * @deprecated Superseded by
	 *   {@link import('../../types/run/checkpoint-store.js').CheckpointStore.listDurableRuns},
	 *   reached through {@link import('./listing.js').listDurableRuns}.
	 *   Removed in the next major.
	 *
	 *   Three things are wrong with `index.json` as the answer to "which runs
	 *   are there":
	 *
	 *   1. Its entries carry no tenant, project or session, so a row cannot be
	 *      turned back into an addressable scope — nothing can be resumed or
	 *      swept from it.
	 *   2. `addToIndex` skips every sub-run, so an inbox built on it drops
	 *      every approval raised by delegated work, and the symptom looks like
	 *      a hung specialist rather than a blind listing.
	 *   3. It is a catalogue of runs that STARTED, not of runs with durable
	 *      state, so it cannot tell a run something could resume from one that
	 *      left nothing behind.
	 *
	 *   Deprecated for one minor rather than deleted outright: this is public
	 *   surface and a consumer calling it today gets real data back, so the
	 *   deprecate-before-you-remove rule applies.
	 */
	static async listRuns(baseDir: string): Promise<
		Array<{
			id: string
			agentName: string
			status: string
			startedAt: number
			endedAt?: number
		}>
	> {
		// Read from each run's `run.json` rather than from `index.json`. The
		// catalogue repeated those fields in a second file that was rewritten
		// whole at every settle; the kernel stopped writing it, and the rows
		// are the same ones it held. Top-level runs only, as before.
		let names: string[]
		try {
			names = await readdir(baseDir)
		} catch (err) {
			if (isFileNotFound(err) || isNotADirectory(err)) return []
			throw err
		}
		const rows: {
			id: string
			agentId?: string
			agentName: string
			model?: string
			status: string
			startedAt: number
			endedAt?: number
			iterations?: number
			totalTokens?: number
		}[] = []
		for (const name of names) {
			if (!isEntityId(name, 'run')) continue
			let meta: Record<string, unknown> | undefined
			try {
				meta = asRecord(JSON.parse(await readFile(join(baseDir, name, 'run.json'), 'utf-8')))
			} catch (err) {
				if (isFileNotFound(err) || isNotADirectory(err) || err instanceof SyntaxError) continue
				throw err
			}
			if (!meta || typeof meta.parentRunId === 'string') continue
			const metadata = asRecord(meta.metadata)
			const config = asRecord(metadata?.config)
			const usage = asRecord(meta.tokenUsage)
			rows.push({
				id: typeof meta.id === 'string' ? meta.id : name,
				...(typeof metadata?.agentId === 'string' ? { agentId: metadata.agentId } : {}),
				agentName: typeof metadata?.agentName === 'string' ? metadata.agentName : '',
				...(typeof config?.model === 'string' ? { model: config.model } : {}),
				status: typeof meta.status === 'string' ? meta.status : 'idle',
				startedAt: typeof meta.startedAt === 'number' ? meta.startedAt : 0,
				...(typeof meta.endedAt === 'number' ? { endedAt: meta.endedAt } : {}),
				...(typeof meta.currentIteration === 'number' ? { iterations: meta.currentIteration } : {}),
				...(typeof usage?.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {}),
			})
		}
		return rows.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
	}

	/**
	 * Every delegated child run saved under one parent, oldest first.
	 *
	 * The sibling of {@link RunDiskStore.listRuns}, and deliberately not a fix
	 * to it. `addToIndex` returns early for any run with a `parentRunId`, which
	 * is what keeps delegated children out of `index.json` and therefore out of
	 * a host's conversation listing — a child is not a conversation anyone
	 * resumes, and putting one there would offer to continue work whose parent
	 * turn is long over. That guard stays. This walks the `children/` directory
	 * instead, so the evidence a child already wrote is reachable by something
	 * that came looking for it, without any of it becoming resumable.
	 *
	 * READ-ONLY, and that matters more here than for most reads: binding a
	 * {@link RunDiskStore} to a run CREATES its directory, so discovery had to
	 * be a free walk or it would mint the very directories it claims to find.
	 * Nothing here writes, moves or prunes.
	 *
	 * Tolerant of half-written evidence, the same way the transcript reader
	 * next door is. A child directory with no `run.json` — a run killed before
	 * its terminal write — is SKIPPED rather than reported with invented
	 * fields, and so is one whose `run.json` is not readable JSON. What is
	 * skipped is the listing row, not the directory: a caller that knows the
	 * run id can still read the transcript beside it.
	 *
	 * Oldest first, by `startedAt`, so the order matches the order the parent
	 * launched them. A child whose `run.json` never recorded a start sorts
	 * first; there is no later moment to claim for it.
	 *
	 * `baseDir` is the runs directory the parent was written under — the same
	 * {@link RunStoreConfig.baseDir} the child's store had, which is why one
	 * parent's children can be spread across several of them when a host gives
	 * each child its own session directory.
	 */
	static async listChildren(
		baseDir: string,
		parentRunId: string,
	): Promise<readonly DelegatedChildRun[]> {
		asRunId(parentRunId)
		const childrenDir = join(baseDir, parentRunId, 'children')
		let names: string[]
		try {
			names = await readdir(childrenDir)
		} catch (err) {
			if (isFileNotFound(err) || isNotADirectory(err)) return []
			throw err
		}

		const children: DelegatedChildRun[] = []
		for (const name of names) {
			const dir = join(childrenDir, name)
			let meta: unknown
			try {
				meta = JSON.parse(await readFile(join(dir, 'run.json'), 'utf-8'))
			} catch (err) {
				// ENOTDIR covers a stray file sitting beside the child directories.
				if (isFileNotFound(err) || isNotADirectory(err) || err instanceof SyntaxError) continue
				throw err
			}
			if (meta === null || typeof meta !== 'object') continue
			const record = meta as Record<string, unknown>
			const metadata = asRecord(record.metadata)
			const config = asRecord(metadata?.config)
			const usage = asRecord(record.tokenUsage)
			children.push({
				id: name,
				parentRunId,
				dir,
				...(typeof metadata?.agentId === 'string' ? { agentId: metadata.agentId } : {}),
				...(typeof metadata?.agentName === 'string' ? { agentName: metadata.agentName } : {}),
				...(typeof config?.model === 'string' ? { model: config.model } : {}),
				...(isRunExecutionStatus(record.status) ? { status: record.status } : {}),
				...(typeof record.startedAt === 'number' ? { startedAt: record.startedAt } : {}),
				...(typeof record.endedAt === 'number' ? { endedAt: record.endedAt } : {}),
				...(typeof usage?.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {}),
				...(typeof record.depth === 'number' ? { depth: record.depth } : {}),
			})
		}
		return children.sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
	}

	/**
	 * @deprecated The kernel no longer calls it, and {@link RunDiskStore.listRuns}
	 *   no longer reads the file it maintains: `index.json` repeated fields
	 *   every run's `run.json` already holds. Removed in a later major.
	 */
	async addToIndex(run: Run): Promise<void> {
		if (run.parentRunId) return

		const prev = this.indexLock
		let resolve!: () => void
		this.indexLock = new Promise<void>((r) => {
			resolve = r
		})

		try {
			await prev

			const indexPath = join(this.baseDir, 'index.json')
			let index: Record<string, unknown>[] = []

			try {
				const content = await readFile(indexPath, 'utf-8')
				index = migrate(SCHEMA, JSON.parse(content))
			} catch (err) {
				if (!isFileNotFound(err)) throw err
			}

			const entry = {
				id: run.id,
				agentId: run.metadata.agentId,
				agentName: run.metadata.agentName,
				model: run.metadata.config.model,
				status: run.status,
				startedAt: run.startedAt,
				endedAt: run.endedAt,
				iterations: run.currentIteration,
				totalTokens: run.tokenUsage.totalTokens,
			}

			const existingIdx = index.findIndex((e) => e.id === run.id)
			if (existingIdx >= 0) {
				index[existingIdx] = entry
			} else {
				index.push(entry)
			}

			await atomicWriteJson(indexPath, index)
		} finally {
			resolve?.()
		}
	}
}

/**
 * Every durable event under one run directory, oldest first.
 *
 * A free function for the same reason {@link readCheckpointsIn} is one: a
 * caller catching up on a run this process never started would otherwise have
 * to bind a {@link RunDiskStore} to read it, and binding one CREATES the
 * directory. A read that mints an empty run directory then answers "no events"
 * is indistinguishable from a run that genuinely has none.
 *
 * ## Unsequenced lines take their position
 *
 * A transcript written before events were numbered carries no `seq` at all.
 * Numbering those lines by their 1-based position is what keeps their evidence
 * reachable: a legacy run of five lines reads back as 1..5, seeds the emitter
 * at 5, and its next event is 6 — continuous, and stable on every later read.
 * Skipping them instead would erase a run's whole history from a catch-up, and
 * synthesising nothing at all would put the emitter back at 1 on top of a log
 * that already has five entries.
 *
 * A damaged line is skipped rather than refused, which is the one place this
 * differs from the checkpoint reader next door, and deliberately: a checkpoint
 * is read to RESUME from, so a damaged one must stop the resume, while the
 * transcript is read to REPORT from, and dropping every event after a torn line
 * would be a larger loss than the torn line itself. The position count still
 * advances over it, so the numbering of the events after it is unchanged.
 */
export async function readRunEventsIn(
	runDir: string,
	options?: ReadRunEventsOptions,
): Promise<readonly PersistedRunEvent[]> {
	let raw: string
	try {
		raw = await readFile(join(runDir, 'transcript.jsonl'), 'utf-8')
	} catch (err) {
		if (isFileNotFound(err)) return []
		throw err
	}

	const sinceSeq = options?.sinceSeq ?? 0
	const strict = options?.integrity === 'strict'
	if (strict && raw.length > 0 && !raw.endsWith('\n')) {
		throw new Error(
			`Invalid run transcript in ${join(runDir, 'transcript.jsonl')}: final record is not newline-terminated`,
		)
	}
	const events: PersistedRunEvent[] = []
	let position = 0
	let previousSeq = 0

	for (const line of raw.split('\n')) {
		if (line.length === 0) continue
		position += 1

		let parsed: Record<string, unknown>
		try {
			parsed = JSON.parse(line) as Record<string, unknown>
		} catch (error) {
			if (strict) {
				throw new Error(
					`Invalid run transcript in ${join(runDir, 'transcript.jsonl')}: record ${position} is not valid JSON`,
					{ cause: error },
				)
			}
			continue
		}
		if (parsed === null || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
			if (strict) {
				throw new Error(
					`Invalid run transcript in ${join(runDir, 'transcript.jsonl')}: record ${position} is not an event object`,
				)
			}
			continue
		}

		const seq = typeof parsed.seq === 'number' ? parsed.seq : position
		if (strict && (!Number.isSafeInteger(seq) || seq <= 0 || seq !== previousSeq + 1)) {
			throw new Error(
				`Invalid run transcript in ${join(runDir, 'transcript.jsonl')}: record ${position} has sequence ${String(seq)}, expected ${previousSeq + 1}`,
			)
		}
		previousSeq = seq
		if (seq <= sinceSeq) continue
		parsed = await restoreCompactionRecord(parsed, runDir)

		events.push({
			...parsed,
			seq,
			// Stamped by `appendEvent` since long before it was declared. A line
			// that predates even that gets the only honest answer available:
			// zero, which sorts before every real moment and cannot be mistaken
			// for one.
			timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
		} as unknown as PersistedRunEvent)
	}

	return events
}

/**
 * Read a run's surviving message snapshot without binding a store to it.
 *
 * Binding a {@link RunDiskStore} creates the directory, which would turn a
 * missing run into an apparently empty one. This helper performs no writes.
 */
export async function readRunMessagesIn(runDir: string): Promise<RunMessageSnapshot> {
	const path = join(runDir, 'messages.json')
	try {
		return await withRunHistoryLock(runDir, () =>
			readRecordResolving(path, (raw) => parseMessageSnapshot(raw, runDir)),
		)
	} catch (err) {
		if (isFileNotFound(err)) return { kind: 'unavailable', reason: 'not-persisted' }
		throw err
	}
}

async function parseMessageSnapshot(raw: string, runDir: string): Promise<RunMessageSnapshot> {
	const path = join(runDir, 'messages.json')
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error(`Invalid run message snapshot in ${path}: invalid JSON`)
	}

	// The pre-boundary format was the message array itself. Preserve access to
	// those bytes, but do not manufacture the event-log boundary it never held.
	if (Array.isArray(parsed)) {
		return { kind: 'legacy-unverified', messages: parsed as Message[] }
	}

	const record = (parsed ?? {}) as Record<string, unknown>
	const throughEventSeq = record.throughEventSeq
	const bounded =
		typeof throughEventSeq === 'number' &&
		Number.isSafeInteger(throughEventSeq) &&
		throughEventSeq >= 0
	if (
		bounded &&
		record.format === 'namzu.run-message-snapshot.v1' &&
		Array.isArray(record.messages)
	) {
		return {
			kind: 'available',
			throughEventSeq,
			messages: record.messages as Message[],
		}
	}
	if (bounded && record.format === RUN_MESSAGE_SNAPSHOT_V2 && isRunHistoryRef(record.history)) {
		const history = openRunHistory(runDir)
		try {
			return {
				kind: 'available',
				throughEventSeq,
				messages: await resolveRunHistory(record.history, history, path),
			}
		} finally {
			await history.close()
		}
	}
	throw new Error(`Invalid run message snapshot in ${path}: expected a versioned snapshot`)
}

/**
 * Terminate a transcript whose last line was cut off mid-write.
 *
 * A process killed during `appendFile` leaves a fragment with no newline. The
 * next append lands on the same line, so the fragment and a WHOLE, correct
 * event merge into one unparsable line — and the reader skips it. The event was
 * written, the emitter counted it as durable, and it is gone.
 *
 * Ending the fragment is enough. It stays unreadable and is skipped as it
 * always was; everything appended after it survives, which is the difference
 * between losing one event and losing one event plus the next.
 *
 * Called from `initRun`, which is the only moment the store knows nothing is
 * mid-write.
 */
async function healTornTranscript(runDir: string): Promise<void> {
	const path = join(runDir, 'transcript.jsonl')
	let raw: string
	try {
		raw = await readFile(path, 'utf-8')
	} catch (err) {
		if (isFileNotFound(err)) return
		throw err
	}
	if (raw.length === 0 || raw.endsWith('\n')) return
	await appendFile(path, '\n', 'utf-8')
}

/**
 * Terminate an audit trail whose last line was cut off mid-write.
 *
 * Same failure mode {@link healTornTranscript} exists for, on `audit.jsonl`'s
 * own file: a process killed mid-`appendFile` leaves a fragment with no
 * newline, and the NEXT append would land on that same line — merging a
 * whole, correct event into an unparsable one and losing BOTH rather than
 * just the fragment. Called from `initRun`, the only moment the store knows
 * nothing is mid-write, exactly like its transcript counterpart.
 */
async function healTornAuditTrail(runDir: string): Promise<void> {
	const path = join(runDir, 'audit.jsonl')
	let raw: string
	try {
		raw = await readFile(path, 'utf-8')
	} catch (err) {
		if (isFileNotFound(err)) return
		throw err
	}
	if (raw.length === 0 || raw.endsWith('\n')) return
	await appendFile(path, '\n', 'utf-8')
}

/**
 * Every checkpoint stored under one run directory, ascending by `createdAt`.
 *
 * A free function rather than a method because the scope-level listing walks
 * run directories it has never bound a {@link RunDiskStore} to — and binding
 * one would CREATE the directory, which is not something a read should do.
 * Sharing the function is what keeps the two read paths from disagreeing
 * about what a damaged file means.
 *
 * An unreadable checkpoint used to be logged and skipped, so this returned a
 * silently short list that four callers treat as complete. A missing NEWEST
 * checkpoint quietly resumes from an older point and re-runs a whole
 * iteration of tool calls; a missing PARKED one reports "not parked" and
 * drops an approval a human already granted, because the file is the only
 * durable record of a park. Pruning under-deletes too: a file the keep-count
 * cannot see is immortal. The by-id read next door was already strict, and
 * two read paths disagreeing about whether damage matters is how the lenient
 * one gets trusted.
 *
 * The same reasoning carries up to the listing, which is why the throw
 * propagates there rather than dropping the run: a damaged checkpoint that
 * removed a run from an approval inbox is the missing-park failure again,
 * one level up.
 *
 * A missing `checkpoints/` directory is the only absence that reads as
 * empty — the run genuinely has none. A file that disappears BETWEEN the
 * directory listing and its read throws, where the old shape returned the
 * empty array and discarded every checkpoint it had already parsed.
 */
export async function readCheckpointsIn(runDir: string): Promise<IterationCheckpoint[]> {
	const cpDir = join(runDir, 'checkpoints')
	return withRunHistoryLock(runDir, async () => {
		let files: string[]
		try {
			files = await readdir(cpDir)
		} catch (err) {
			if (isFileNotFound(err)) return []
			throw err
		}

		// One read of each log for the whole listing, however many checkpoints
		// reference it. Each checkpoint still gets objects of its own.
		const history = loadRunHistory(runDir)
		const checkpoints: IterationCheckpoint[] = []
		for (const file of files) {
			if (!file.endsWith('.json')) continue
			checkpoints.push(
				await readRecordResolving(join(cpDir, file), (content) =>
					parseCheckpoint(content, file, history),
				),
			)
		}
		return checkpoints.sort((a, b) => a.createdAt - b.createdAt)
	})
}

/**
 * A checkpoint with its messages left where they are.
 *
 * What retention and a durable-run listing read: ids, times, parks and
 * attribution. Resolving every history to answer "which checkpoints are
 * there" re-read the whole log on every iteration, and made one damaged
 * history refuse the listing of all of them.
 */
export type CheckpointHeader = Omit<IterationCheckpoint, 'messages'>

/**
 * Every checkpoint of a run, headers only, oldest first.
 *
 * Validated exactly as {@link readCheckpointsIn} validates — a file that is
 * not a checkpoint throws — except that the history is not resolved, so a
 * damaged log does not stop it.
 */
export async function readCheckpointHeadersIn(runDir: string): Promise<CheckpointHeader[]> {
	return (await readCheckpointFilesIn(runDir)).map((f) => f.header)
}

/** A checkpoint file read once: where it is, its JSON as stored, its header. */
interface CheckpointFile {
	readonly path: string
	readonly file: string
	readonly stored: Record<string, unknown>
	readonly header: CheckpointHeader
}

/** Every checkpoint file of a run, parsed and validated, oldest first. */
async function readCheckpointFilesIn(runDir: string): Promise<CheckpointFile[]> {
	const cpDir = join(runDir, 'checkpoints')
	let names: string[]
	try {
		names = await readdir(cpDir)
	} catch (err) {
		if (isFileNotFound(err)) return []
		throw err
	}
	const files: CheckpointFile[] = []
	for (const file of names) {
		if (!file.endsWith('.json')) continue
		const path = join(cpDir, file)
		let content: string
		try {
			content = await readFile(path, 'utf-8')
		} catch (err) {
			// Pruned between the listing and the read: it is not there.
			if (isFileNotFound(err)) continue
			throw err
		}
		const stored = JSON.parse(content) as Record<string, unknown>
		const { messages: _inline, history: _ref, ...header } = parseCheckpointRecord(content, file)
		files.push({ path, file, stored, header: header as CheckpointHeader })
	}
	return files.sort((a, b) => a.header.createdAt - b.header.createdAt)
}

/**
 * Read a record and resolve it, retrying once if its history moved.
 *
 * A compaction in another process can delete the generation a record
 * pointed at between reading the record and reading the log. The record it
 * rewrote points at the new generation, so reading it again is the answer.
 * Within one process the history lock already excludes this.
 */
async function readRecordResolving<T>(
	path: string,
	resolveRecord: (content: string) => Promise<T>,
): Promise<T> {
	const content = await readFile(path, 'utf-8')
	try {
		return await resolveRecord(content)
	} catch (error) {
		if (!(error instanceof RunHistoryRefusal) || !error.missing) throw error
		let again: string
		try {
			again = await readFile(path, 'utf-8')
		} catch {
			throw error
		}
		if (again === content) throw error
		return resolveRecord(again)
	}
}

/**
 * Collect the history lines no record of the run references any more.
 *
 * Checks first, from the references alone, whether enough is dead to be
 * worth a copy; see {@link compactRunHistoryLocked}.
 */
export async function compactRunHistory(
	runDir: string,
	options: { readonly minReclaimBytes?: number } = {},
): Promise<RunHistoryCompaction> {
	return withRunHistoryLock(runDir, async () =>
		compactRunHistoryLocked(runDir, await historyRoots(runDir), options),
	)
}

/** Every record of the run that references its history log. */
async function historyRoots(runDir: string): Promise<RunHistoryRoot[]> {
	return [
		...(await readCheckpointFilesIn(runDir)).flatMap(checkpointRoot),
		...(await snapshotRoot(runDir)),
	]
}

/** A checkpoint as a compaction root, or nothing when it stores messages inline. */
function checkpointRoot({ path, file, stored, header }: CheckpointFile): RunHistoryRoot[] {
	if (!isRunHistoryRef(stored.history)) return []
	return [
		{
			file,
			ref: stored.history,
			order: header.createdAt,
			// The stamp and every other field are carried over as they were.
			rewrite: (history) => durableWriteFile(path, JSON.stringify({ ...stored, history })),
		},
	]
}

/** The settled `messages.json` as a compaction root, when it is a reference. */
async function snapshotRoot(runDir: string): Promise<RunHistoryRoot[]> {
	const path = join(runDir, 'messages.json')
	let snapshot: Record<string, unknown>
	try {
		snapshot = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
	} catch (err) {
		if (isFileNotFound(err)) return []
		throw err
	}
	if (snapshot.format !== RUN_MESSAGE_SNAPSHOT_V2 || !isRunHistoryRef(snapshot.history)) return []
	return [
		{
			file: 'messages.json',
			ref: snapshot.history,
			// The settled history is the newest thing the run wrote.
			order: Number.MAX_SAFE_INTEGER,
			rewrite: (history) =>
				durableWriteFile(path, JSON.stringify({ ...snapshot, history }, null, 2)),
		},
	]
}

async function atomicWriteJson(
	filePath: string,
	value: unknown,
	schema = SCHEMA,
	layout: 'indented' | 'compact' = 'indented',
): Promise<void> {
	const stamped = stamp(schema, value)
	await atomicWriteFile(
		filePath,
		layout === 'compact' ? JSON.stringify(stamped) : JSON.stringify(stamped, null, 2),
	)
}

/**
 * Parse a checkpoint, checking it is one.
 *
 * Both read paths were `JSON.parse(content) as IterationCheckpoint` — a
 * cast, not a check, so `{}` passed both and failed much later at the
 * point of use, where the message names a missing property rather than a
 * damaged file. The fields checked here are the ones the resume path
 * dereferences immediately; the rest are optional and their absence is
 * survivable.
 */
/** A finite number, not `NaN` and not `Infinity`. */
function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The budget fields a resume restores before its first iteration.
 *
 * Checked because a resume DEREFERENCES them: a run recalled at $4.80 of a
 * $5 cap whose `costInfo` came back malformed continues with `NaN`
 * budgets, which compare false against every limit — so the guard that
 * exists to stop it silently never stops it. That is a run that looks
 * healthy and has lost its cap, which is worse than one that refuses to
 * resume.
 */
function hasUsableBudgets(record: Partial<IterationCheckpoint>): boolean {
	const usage = record.tokenUsage as Record<string, unknown> | undefined
	const cost = record.costInfo as Record<string, unknown> | undefined
	const guard = record.guardState as Record<string, unknown> | undefined
	if (!usage || !cost || !guard) return false
	return (
		isCount(usage.promptTokens) &&
		isCount(usage.completionTokens) &&
		isCount(usage.totalTokens) &&
		isCount(cost.totalCost) &&
		isCount(guard.iterationCount) &&
		isCount(guard.elapsedMs)
	)
}

type CheckpointRecord = Partial<IterationCheckpoint> & {
	id: string
	iteration: number
	createdAt: number
	history?: RunHistoryRef
}

/** Parse and validate a checkpoint file, leaving its history unresolved. */
function parseCheckpointRecord(content: string, file: string): CheckpointRecord {
	const parsed = migrate<unknown>(CHECKPOINT_SCHEMA, JSON.parse(content))
	const record = parsed as (Partial<IterationCheckpoint> & { history?: unknown }) | null

	if (
		record === null ||
		typeof record !== 'object' ||
		typeof record.id !== 'string' ||
		typeof record.iteration !== 'number' ||
		typeof record.createdAt !== 'number' ||
		!(Array.isArray(record.messages) || isRunHistoryRef(record.history))
	) {
		throw new Error(
			`Checkpoint file "${file}" is not a usable checkpoint: it parsed as JSON but is missing the fields a resume needs (id, iteration, createdAt, messages). Refusing rather than resuming from it.`,
		)
	}

	if (!hasUsableBudgets(record)) {
		throw new Error(
			`Checkpoint file "${file}" has malformed budget state (tokenUsage, costInfo, guardState). A resume restores these before its first iteration, so reading them as NaN or undefined produces a run that compares false against every limit and never stops. Refusing rather than resuming without a cap.`,
		)
	}

	return record as CheckpointRecord
}

async function parseCheckpoint(
	content: string,
	file: string,
	history: RunHistorySource,
): Promise<IterationCheckpoint> {
	const record = parseCheckpointRecord(content, file)
	if (Array.isArray(record.messages)) return record as IterationCheckpoint
	const { history: ref, ...rest } = record
	const messages = await resolveRunHistory(ref as RunHistoryRef, history, file)
	return { ...rest, messages } as IterationCheckpoint
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined
}

const RUN_EXECUTION_STATUSES: readonly RunExecutionStatus[] = [
	'idle',
	'pending',
	'running',
	'completed',
	'failed',
	'cancelled',
]

function isRunExecutionStatus(value: unknown): value is RunExecutionStatus {
	return typeof value === 'string' && RUN_EXECUTION_STATUSES.includes(value as RunExecutionStatus)
}

/** A path component that is a file where a directory was expected. */
function isNotADirectory(err: unknown): boolean {
	return (
		typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOTDIR'
	)
}

function isFileNotFound(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
