import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
	ReadRunEventsOptions,
	RunMessageSnapshot,
	RunStore,
} from '../../types/run/store.js'
import { atomicWriteFile } from '../../utils/atomic-write.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { defineSchema, migrate, stamp } from '../schema.js'

/**
 * This store's on-disk format, versioned as a unit — which is how a
 * migration would actually be written and shipped, and it keeps every call
 * site free of schema plumbing.
 *
 * Bump `current` and add the migration for the step you are leaving when
 * the shape changes.
 */
const SCHEMA = defineSchema({ kind: 'run-store', current: 1, migrations: {} })

/**
 * One finished tool call, recovered from the transcript.
 *
 * Re-exported from the store contract rather than declared twice. Two
 * declarations of one concept, each populated by its own mapper, is the shape
 * this repository has a rule about.
 */
export type { CompletedToolRecord }

export class RunDiskStore implements RunStore {
	private baseDir: string
	private runDir: string | null = null
	private log: Logger
	private indexLock: Promise<void> = Promise.resolve()

	constructor(config: RunStoreConfig) {
		this.baseDir = config.baseDir
		this.log = resolveLogger(config.logger).child({ [SCOPE_ATTRIBUTE]: 'store/run/disk' })
	}

	private requireInit(): string {
		if (!this.runDir) {
			throw new Error('RunDiskStore not initialized — call initRun() first')
		}
		return this.runDir
	}

	async initRun(runId: string, parentRunId?: string): Promise<string> {
		if (parentRunId) {
			this.runDir = join(this.baseDir, parentRunId, 'children', runId)
		} else {
			this.runDir = join(this.baseDir, runId)
		}
		await mkdir(this.runDir, { recursive: true })
		await healTornTranscript(this.runDir)
		await healTornAuditTrail(this.runDir)
		this.log.info('Run directory created', { 'namzu.run.dir': this.runDir })
		return this.runDir
	}

	async appendEvent(event: RunEvent): Promise<void> {
		const dir = this.requireInit()

		const line = `${JSON.stringify({
			...event,
			timestamp: Date.now(),
		})}\n`

		await appendFile(join(dir, 'transcript.jsonl'), line, 'utf-8')
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

	async writeMessages(run: Run, throughEventSeq: number): Promise<void> {
		const dir = this.requireInit()
		await atomicWriteJson(join(dir, 'messages.json'), {
			format: 'namzu.run-message-snapshot.v1',
			throughEventSeq,
			messages: run.messages,
		})
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
		const dir = this.requireInit()
		const cpDir = join(dir, 'checkpoints')
		await mkdir(cpDir, { recursive: true })
		// Stamped, not written bare. Unstamped is read as version 1 by
		// definition, which is correct only while version 1 is the only
		// version there has ever been — the moment a second one exists, an
		// unstamped file written by the newer build is read by the older one
		// as if it were the older shape, and the refusal that exists to
		// prevent exactly that never fires. The stamp is what gives the
		// migration chain something to hang on.
		await atomicWriteJson(join(cpDir, `${checkpoint.id}.json`), stamp(SCHEMA, checkpoint))
	}

	async readCheckpoint(checkpointId: CheckpointId): Promise<IterationCheckpoint | null> {
		const dir = this.requireInit()
		try {
			const content = await readFile(join(dir, 'checkpoints', `${checkpointId}.json`), 'utf-8')
			return parseCheckpoint(content, `${checkpointId}.json`)
		} catch (err) {
			if (isFileNotFound(err)) return null
			throw err
		}
	}

	async listCheckpoints(): Promise<IterationCheckpoint[]> {
		return readCheckpointsIn(this.requireInit())
	}

	async deleteCheckpoint(checkpointId: CheckpointId): Promise<void> {
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
		try {
			const indexPath = join(baseDir, 'index.json')
			const content = await readFile(indexPath, 'utf-8')
			return migrate(SCHEMA, JSON.parse(content))
		} catch (err) {
			if (isFileNotFound(err)) return []
			throw err
		}
	}

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
	const events: PersistedRunEvent[] = []
	let position = 0

	for (const line of raw.split('\n')) {
		if (line.length === 0) continue
		position += 1

		let parsed: Record<string, unknown>
		try {
			parsed = JSON.parse(line) as Record<string, unknown>
		} catch {
			continue
		}
		if (parsed === null || typeof parsed !== 'object' || typeof parsed.type !== 'string') continue

		const seq = typeof parsed.seq === 'number' ? parsed.seq : position
		if (seq <= sinceSeq) continue

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
	let raw: string
	try {
		raw = await readFile(join(runDir, 'messages.json'), 'utf-8')
	} catch (err) {
		if (isFileNotFound(err)) return { kind: 'unavailable', reason: 'not-persisted' }
		throw err
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error(
			`Invalid run message snapshot in ${join(runDir, 'messages.json')}: invalid JSON`,
		)
	}

	// The pre-boundary format was the message array itself. Preserve access to
	// those bytes, but do not manufacture the event-log boundary it never held.
	if (Array.isArray(parsed)) {
		return { kind: 'legacy-unverified', messages: parsed as Message[] }
	}

	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		(parsed as Record<string, unknown>).format !== 'namzu.run-message-snapshot.v1' ||
		typeof (parsed as Record<string, unknown>).throughEventSeq !== 'number' ||
		!Number.isSafeInteger((parsed as Record<string, unknown>).throughEventSeq) ||
		((parsed as Record<string, unknown>).throughEventSeq as number) < 0 ||
		!Array.isArray((parsed as Record<string, unknown>).messages)
	) {
		throw new Error(
			`Invalid run message snapshot in ${join(runDir, 'messages.json')}: expected a versioned snapshot`,
		)
	}

	return {
		kind: 'available',
		throughEventSeq: (parsed as Record<string, unknown>).throughEventSeq as number,
		messages: (parsed as Record<string, unknown>).messages as Message[],
	}
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
	let files: string[]
	try {
		files = await readdir(cpDir)
	} catch (err) {
		if (isFileNotFound(err)) return []
		throw err
	}

	const checkpoints: IterationCheckpoint[] = []
	for (const file of files) {
		if (!file.endsWith('.json')) continue
		const content = await readFile(join(cpDir, file), 'utf-8')
		checkpoints.push(parseCheckpoint(content, file))
	}
	return checkpoints.sort((a, b) => a.createdAt - b.createdAt)
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await atomicWriteFile(filePath, JSON.stringify(stamp(SCHEMA, value), null, 2))
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

function parseCheckpoint(content: string, file: string): IterationCheckpoint {
	const parsed = migrate<unknown>(SCHEMA, JSON.parse(content))
	const record = parsed as Partial<IterationCheckpoint> | null

	if (
		record === null ||
		typeof record !== 'object' ||
		typeof record.id !== 'string' ||
		typeof record.iteration !== 'number' ||
		typeof record.createdAt !== 'number' ||
		!Array.isArray(record.messages)
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

	return record as IterationCheckpoint
}

function isFileNotFound(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
