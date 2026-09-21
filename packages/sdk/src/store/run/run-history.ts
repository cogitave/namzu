import { createHash } from 'node:crypto'
import {
	type FileHandle,
	appendFile,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	stat,
	unlink,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Message } from '../../types/message/index.js'
import { syncDirectory, temporaryPathFor } from '../../utils/atomic-write.js'

/**
 * One run's message history, stored once.
 *
 * ## Why this exists
 *
 * A checkpoint used to carry the whole conversation inline. The run takes one
 * every iteration (and another at every tool review), so an N-iteration run
 * wrote the history N times over — quadratic in the run's length. Measured on
 * one machine before it was cleaned: 19,014 checkpoint files, 6.33 GB, one run
 * alone holding 532 checkpoints of about 1.5 MB each. And when the run
 * settled, `messages.json` wrote the same history once more.
 *
 * Now every distinct message is appended once to the run's history log, in
 * `<runDir>/history/`, and every record that needs a history — each
 * checkpoint, and the settled `messages.json` — stores a {@link RunHistoryRef}
 * naming which lines make it up: runs of consecutive lines
 * (`[log, offset, length, count]`), the total count, and a SHA-256 over
 * exactly those bytes in order. The log is the run's one message record; the
 * records are views of it.
 *
 * There are two logs, and which one a new message goes to is what keeps a
 * reference short. A message that extends the history — part of the run of
 * new messages at its END — goes to `messages.<g>.jsonl`, so the history the
 * run keeps appending to stays one contiguous range there. A new message
 * anywhere else is an EDIT: the working-memory slot a pinned fact rewrites
 * every iteration, the summary a compaction puts where the head used to be.
 * Those go to `edits.<g>.jsonl`. With one log, each iteration's rewritten pin
 * landed between that iteration's messages and the next, and every later
 * reference needed one range per iteration to step around them.
 *
 * ## Generations, and why the log does not grow forever
 *
 * A line nothing references any more — a pin slot rewritten since, a head a
 * compaction replaced, the history of a checkpoint that retention pruned —
 * is dead weight. {@link compactRunHistoryLocked} copies the lines that are
 * still referenced into generation `g + 1`, repoints every record at it (the
 * digest does not change: the same bytes in the same order), and deletes the
 * older generations. It runs only when the dead bytes exceed the live ones,
 * so the log stays within about twice the size of the history that is still
 * referenced, and the copying is amortised to a constant per byte written.
 *
 * ## What it keeps from the inline format
 *
 * - **Refusal over a silent partial read.** The digest covers the referenced
 *   bytes, so a truncated, edited or missing log refuses the record the same
 *   way a damaged inline one is refused — a resume must never continue from
 *   a history it cannot vouch for.
 * - **Old records read unchanged.** A checkpoint that carries `messages`
 *   inline, and a `messages.json` in the v1 snapshot format, are read
 *   exactly as before; only new writes use the log.
 * - **The public shape.** Readers still get an `IterationCheckpoint` with its
 *   `messages` and a `RunMessageSnapshot`; resolving the reference is the
 *   store's job.
 *
 * ## Concurrency
 *
 * Every write and every compaction of one run directory runs under
 * {@link withRunHistoryLock}, which is shared by every store in the process
 * bound to that directory — the run's own persistence and the checkpoint
 * store are two instances. A record is written (log append plus the file that
 * references it) inside the lock, so a compaction can never see the append
 * without the reference and collect it. Across processes appends are single
 * `O_APPEND` writes and a writer that finds a log at a length it did not
 * predict rebuilds its index from the file; compaction is not coordinated
 * across processes, and a reader that loses a generation to one retries from
 * the record it read. Two processes writing one run at once is a split claim,
 * which the claim fence exists to refuse.
 */

export const RUN_HISTORY_FORMAT = 'namzu.run-history.v1'

/** The directory, inside a run's directory, that holds its history logs. */
export const RUN_HISTORY_DIR = 'history'

type LogIndex = 0 | 1

const LOG_NAMES = ['messages', 'edits'] as const
const LOG_FILE = /^(messages|edits)\.(0|[1-9]\d{0,8})\.jsonl$/

/** File name of one log of one generation. */
export function runHistoryLogFile(generation: number, log: LogIndex): string {
	return `${LOG_NAMES[log]}.${generation}.jsonl`
}

/** `[log, byte offset, byte length, line count]` of consecutive lines of one log. */
export type RunHistorySegment = readonly [LogIndex, number, number, number]

/** What a record stores in place of its messages. */
export interface RunHistoryRef {
	readonly format: typeof RUN_HISTORY_FORMAT
	/** The generation of the logs the segments point into. */
	readonly generation: number
	readonly count: number
	/** SHA-256 (hex) of every referenced line, newline included, in order. */
	readonly sha256: string
	readonly segments: readonly RunHistorySegment[]
}

interface Location {
	readonly offset: number
	readonly length: number
}

interface Placed extends Location {
	readonly log: LogIndex
}

function sha256(value: Uint8Array | string): string {
	return createHash('sha256').update(value).digest('hex')
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Structural check of a parsed reference. */
export function isRunHistoryRef(value: unknown): value is RunHistoryRef {
	if (value === null || typeof value !== 'object') return false
	const ref = value as Record<string, unknown>
	if (ref.format !== RUN_HISTORY_FORMAT) return false
	if (!isNonNegativeInteger(ref.generation) || !isNonNegativeInteger(ref.count)) return false
	if (typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256)) return false
	if (!Array.isArray(ref.segments)) return false
	let total = 0
	for (const segment of ref.segments) {
		if (
			!Array.isArray(segment) ||
			segment.length !== 4 ||
			(segment[0] !== 0 && segment[0] !== 1) ||
			!segment.every(isNonNegativeInteger) ||
			(segment[3] as number) < 1 ||
			(segment[2] as number) < (segment[3] as number)
		)
			return false
		total += segment[3] as number
	}
	return total === ref.count
}

// ---------------------------------------------------------------------------
// The per-directory lock
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>()

/**
 * Run `operation` exclusively for one run directory, within this process.
 *
 * Keyed by the resolved path, so every store bound to the directory shares
 * it however it spelled the path. The entry is dropped once nothing is
 * queued, so a long-lived process does not keep one per run it ever touched.
 */
export function withRunHistoryLock<T>(runDir: string, operation: () => Promise<T>): Promise<T> {
	const key = resolve(runDir)
	const previous = locks.get(key) ?? Promise.resolve()
	const result = previous.then(operation)
	const tail = result.then(
		() => {},
		() => {},
	)
	locks.set(key, tail)
	void tail.then(() => {
		if (locks.get(key) === tail) locks.delete(key)
	})
	return result
}

// ---------------------------------------------------------------------------
// Placement: shared by the writer and by compaction
// ---------------------------------------------------------------------------

/**
 * Which log each line goes to, or `undefined` when it is already stored.
 *
 * The run of unknown lines at the END extends the history and goes to the
 * main log; any other unknown line is an edit. A line that repeats within
 * `keys` is stored once.
 */
function planAppends(
	keys: readonly string[],
	known: (key: string) => boolean,
): (LogIndex | undefined)[] {
	let tail = keys.length
	while (tail > 0 && !known(keys[tail - 1] as string)) tail--
	const seen = new Set<string>()
	return keys.map((key, i) => {
		if (known(key) || seen.has(key)) return undefined
		seen.add(key)
		return i >= tail ? 0 : 1
	})
}

function toSegments(
	keys: readonly string[],
	locate: (key: string) => Placed | undefined,
	where: string,
): [LogIndex, number, number, number][] {
	const segments: [LogIndex, number, number, number][] = []
	for (const key of keys) {
		const placed = locate(key)
		if (!placed) {
			throw new Error(
				`Run history in ${where} lost a line it had just written; refusing to publish a record that references it.`,
			)
		}
		const last = segments.at(-1)
		if (last && last[0] === placed.log && last[1] + last[2] === placed.offset) {
			last[2] += placed.length
			last[3] += 1
		} else {
			segments.push([placed.log, placed.offset, placed.length, 1])
		}
	}
	return segments
}

function splitLines(messages: readonly Message[]): {
	lines: Buffer[]
	keys: string[]
	whole: string
} {
	const lines = messages.map((message) => Buffer.from(`${JSON.stringify(message) ?? 'null'}\n`))
	const hash = createHash('sha256')
	const keys = lines.map((line) => {
		hash.update(line)
		return sha256(line)
	})
	return { lines, keys, whole: hash.digest('hex') }
}

/** Generations present in `dir`, ascending. */
async function listGenerations(dir: string): Promise<number[]> {
	let names: string[]
	try {
		names = await readdir(dir)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const found = new Set<number>()
	for (const name of names) {
		const match = LOG_FILE.exec(name)
		if (match) found.add(Number(match[2]))
	}
	return [...found].sort((a, b) => a - b)
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
		throw error
	}
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * One log file of the current generation and the index of what it holds.
 *
 * The index maps a line's digest to where it sits, and is rebuilt from the
 * file whenever the file is not the length this writer last left it.
 */
class LogFile {
	index = new Map<string, Location>()
	end = 0

	constructor(readonly path: string) {}

	async append(lines: readonly Buffer[], predicted: ReadonlyMap<string, Location>): Promise<void> {
		const expected = this.end + lines.reduce((n, line) => n + line.length, 0)
		const handle = await open(this.path, 'a')
		try {
			// No fsync, the same as every other record this store writes: a
			// process crash keeps the page cache, and a power loss that drops
			// these bytes leaves a record whose digest no longer matches, which
			// is refused, not misread. The durability is the inline format's:
			// it was write-then-rename with no fsync either. Measured, an fsync
			// here was 3 ms of every checkpoint.
			await handle.write(Buffer.concat(lines))
		} finally {
			await handle.close()
		}
		if ((await stat(this.path)).size !== expected) {
			// Another process appended in between; the file is the answer.
			await this.rebuild()
			return
		}
		for (const [key, location] of predicted) this.index.set(key, location)
		this.end = expected
	}

	/**
	 * Index the whole file.
	 *
	 * A final line with no newline is a write that died part-way. It is ended
	 * with a newline before anything else is appended — otherwise the next
	 * append would merge a whole line into the fragment and a later scan would
	 * lose it. Same repair, same reasoning, as the transcript's.
	 */
	async rebuild(): Promise<void> {
		let raw: Buffer
		try {
			raw = await readFile(this.path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			raw = Buffer.alloc(0)
		}
		if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
			await appendFile(this.path, '\n')
			raw = Buffer.concat([raw, Buffer.from('\n')])
		}
		const index = new Map<string, Location>()
		let start = 0
		while (start < raw.length) {
			const end = raw.indexOf(0x0a, start) + 1
			const key = sha256(raw.subarray(start, end))
			if (!index.has(key)) index.set(key, { offset: start, length: end - start })
			start = end
		}
		this.index = index
		this.end = raw.length
	}
}

/**
 * The append side, bound to one run directory.
 *
 * A message already in either log of the current generation is referenced
 * rather than written again. Every method is called under
 * {@link withRunHistoryLock}; that is the caller's job, because the lock has
 * to cover the record that publishes the reference too.
 */
export class RunHistoryWriter {
	private readonly dir: string
	private generation = -1
	private logs: [LogFile, LogFile] | undefined

	constructor(runDir: string) {
		this.dir = join(runDir, RUN_HISTORY_DIR)
	}

	/** Make sure every message is stored and return the reference to them. */
	async recordLocked(messages: readonly Message[]): Promise<RunHistoryRef> {
		await mkdir(this.dir, { recursive: true })
		const logs = await this.catchUp()
		const { lines, keys, whole } = splitLines(messages)
		const find = (key: string): Placed | undefined => {
			for (const log of [0, 1] as const) {
				const location = logs[log].index.get(key)
				if (location) return { log, ...location }
			}
			return undefined
		}

		const plan = planAppends(keys, (key) => find(key) !== undefined)
		const pending: [Buffer[], Buffer[]] = [[], []]
		const predicted: [Map<string, Location>, Map<string, Location>] = [new Map(), new Map()]
		const cursor = [logs[0].end, logs[1].end]
		plan.forEach((log, i) => {
			if (log === undefined) return
			const line = lines[i] as Buffer
			predicted[log].set(keys[i] as string, {
				offset: cursor[log] as number,
				length: line.length,
			})
			pending[log].push(line)
			cursor[log] = (cursor[log] as number) + line.length
		})
		for (const log of [0, 1] as const) {
			if (pending[log].length > 0) await logs[log].append(pending[log], predicted[log])
		}

		return {
			format: RUN_HISTORY_FORMAT,
			generation: this.generation,
			count: lines.length,
			sha256: whole,
			segments: toSegments(keys, find, this.dir),
		}
	}

	/** Follow the newest generation, and the files' current lengths. */
	private async catchUp(): Promise<[LogFile, LogFile]> {
		const current = (await listGenerations(this.dir)).at(-1) ?? 0
		if (current !== this.generation || this.logs === undefined) {
			this.generation = current
			this.logs = [
				new LogFile(join(this.dir, runHistoryLogFile(current, 0))),
				new LogFile(join(this.dir, runHistoryLogFile(current, 1))),
			]
			await Promise.all(this.logs.map((log) => log.rebuild()))
			return this.logs
		}
		for (const log of this.logs) {
			if ((await fileSize(log.path)) !== log.end) await log.rebuild()
		}
		return this.logs
	}
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Where a reader gets referenced bytes from. */
export interface RunHistorySource {
	read(generation: number, log: LogIndex, offset: number, length: number): Promise<Buffer>
	close(): Promise<void>
}

/** Read each referenced log once, for resolving many records. */
export function loadRunHistory(runDir: string): RunHistorySource {
	const dir = join(runDir, RUN_HISTORY_DIR)
	const raw = new Map<string, Buffer>()
	return {
		read: async (generation, log, offset, length) => {
			const name = runHistoryLogFile(generation, log)
			let bytes = raw.get(name)
			if (bytes === undefined) {
				bytes = await readFile(join(dir, name))
				raw.set(name, bytes)
			}
			return bytes.subarray(offset, offset + length)
		},
		close: async () => {},
	}
}

/** Positional reads against the logs, for resolving one record. */
export function openRunHistory(runDir: string): RunHistorySource {
	const dir = join(runDir, RUN_HISTORY_DIR)
	const handles = new Map<string, FileHandle>()
	return {
		read: async (generation, log, offset, length) => {
			const name = runHistoryLogFile(generation, log)
			let handle = handles.get(name)
			if (handle === undefined) {
				handle = await open(join(dir, name), 'r')
				handles.set(name, handle)
			}
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, offset)
			return buffer.subarray(0, bytesRead)
		},
		close: async () => {
			await Promise.all([...handles.values()].map((handle) => handle.close()))
		},
	}
}

/** Why a reference could not be resolved. `missing` is a log that is not there. */
export class RunHistoryRefusal extends Error {
	constructor(
		message: string,
		readonly missing: boolean,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'RunHistoryRefusal'
	}
}

/** The referenced lines, as raw bytes each ending in a newline, or a refusal. */
async function resolveLines(
	ref: RunHistoryRef,
	source: RunHistorySource,
	file: string,
): Promise<Buffer[]> {
	const refuse = (why: string, missing = false, cause?: unknown): never => {
		throw new RunHistoryRefusal(
			`Record "${file}" references message history that ${why}. Refusing rather than resuming from a history it cannot vouch for.`,
			missing,
			cause === undefined ? undefined : { cause },
		)
	}
	const whole = createHash('sha256')
	const lines: Buffer[] = []
	for (const [log, offset, length, count] of ref.segments) {
		const name = runHistoryLogFile(ref.generation, log)
		let bytes: Buffer
		try {
			bytes = await source.read(ref.generation, log, offset, length)
		} catch (error) {
			return refuse(
				`cannot be read from ${name}`,
				(error as NodeJS.ErrnoException).code === 'ENOENT',
				error,
			)
		}
		if (bytes.length !== length) {
			return refuse(`is shorter in ${name} than the record says`)
		}
		whole.update(bytes)
		let start = 0
		for (let i = 0; i < count; i++) {
			const newline = bytes.indexOf(0x0a, start)
			if (newline < 0) return refuse('does not hold the lines it records')
			lines.push(bytes.subarray(start, newline + 1))
			start = newline + 1
		}
		if (start !== bytes.length) return refuse('does not hold the lines it records')
	}
	if (whole.digest('hex') !== ref.sha256) return refuse('does not match its digest')
	return lines
}

/**
 * The messages a reference names, or a refusal.
 *
 * Refuses when a log is missing, shorter than the reference, or holds
 * different bytes than the ones the record was written against. Every call
 * parses its own objects: two checkpoints of one listing never share a
 * message, so a caller that edits one history cannot change another.
 */
export async function resolveRunHistory(
	ref: RunHistoryRef,
	source: RunHistorySource,
	file: string,
): Promise<Message[]> {
	const lines = await resolveLines(ref, source, file)
	return lines.map((line) => {
		try {
			return JSON.parse(line.toString('utf8')) as Message
		} catch (error) {
			throw new RunHistoryRefusal(
				`Record "${file}" references message history that holds a line that is not JSON. Refusing rather than resuming from a history it cannot vouch for.`,
				false,
				{ cause: error },
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** A record that references the history, as compaction sees it. */
export interface RunHistoryRoot {
	/** Where the record lives, for messages. */
	readonly file: string
	readonly ref: RunHistoryRef
	/** Oldest first; the order the records were written in, as near as known. */
	readonly order: number
	/**
	 * Publish the record again with `ref` in place of its current reference,
	 * durably: resolve only once the new record and the directory entry that
	 * names it are on stable storage (see `durableWriteFile`). Compaction
	 * deletes the generations the old reference pointed at as soon as every
	 * rewrite has resolved.
	 */
	rewrite(ref: RunHistoryRef): Promise<void>
}

/** What a compaction check found. */
export interface RunHistoryCompaction {
	/** Bytes of every log file of every generation before the check. */
	readonly storedBytes: number
	/** Bytes the records reference, counted once. */
	readonly liveBytes: number
	/** Whether a new generation was written. */
	readonly compacted: boolean
}

/**
 * Don't compact until at least this many bytes are dead. Below it the copy
 * costs more than the space it frees.
 */
export const RUN_HISTORY_MIN_RECLAIM_BYTES = 256 * 1024

/**
 * Bytes the roots reference in each log, counted once — computed from the
 * references alone, without reading a log.
 */
function referencedBytes(roots: readonly RunHistoryRoot[]): number {
	const ranges = new Map<string, [number, number][]>()
	for (const { ref } of roots) {
		for (const [log, offset, length] of ref.segments) {
			const key = runHistoryLogFile(ref.generation, log)
			let list = ranges.get(key)
			if (!list) {
				list = []
				ranges.set(key, list)
			}
			list.push([offset, offset + length])
		}
	}
	let total = 0
	for (const list of ranges.values()) {
		list.sort((a, b) => a[0] - b[0])
		let [start, end] = list[0] as [number, number]
		for (const [s, e] of list.slice(1)) {
			if (s > end) {
				total += end - start
				start = s
				end = e
			} else if (e > end) {
				end = e
			}
		}
		total += end - start
	}
	return total
}

/**
 * Collect the lines no record references any more.
 *
 * Called under {@link withRunHistoryLock} with every record of the run that
 * holds a reference. Does nothing unless the dead bytes exceed both the live
 * ones and `minReclaimBytes`. Otherwise: copies the referenced lines into a
 * new generation (laid out the way the writer would have laid them out,
 * replaying the records oldest first), repoints each record at it, and only
 * then deletes the older generations.
 *
 * What survives a crash, a process crash or a power loss alike: every record
 * points at a generation that still exists, and the next compaction collects
 * whatever the crash left. That holds across a power loss because nothing is
 * deleted until everything it is replaced by is on stable storage — the new
 * generation's files are fsynced, then the history directory that names them;
 * each record is rewritten through an fsynced file and an fsynced directory;
 * only then are the older generations unlinked. A crash before the unlinks
 * leaves some records on the old generation and some on the new, both
 * present. The unlinks themselves are not synced: a power loss after them
 * can bring an old generation's files back, which costs space until the next
 * compaction and nothing else. On Windows the directory syncs are skipped
 * (the platform refuses them) and the directory entries rest on NTFS's own
 * metadata journal. A filesystem or disk that acknowledges an fsync it has
 * not performed is outside what any of this can detect.
 *
 * A record whose history cannot be resolved stops the compaction before
 * anything is written. Collecting around damage could delete the only bytes
 * that could still explain it.
 */
export async function compactRunHistoryLocked(
	runDir: string,
	roots: readonly RunHistoryRoot[],
	options: { readonly minReclaimBytes?: number } = {},
): Promise<RunHistoryCompaction> {
	const dir = join(runDir, RUN_HISTORY_DIR)
	const generations = await listGenerations(dir)
	if (generations.length === 0) return { storedBytes: 0, liveBytes: 0, compacted: false }

	let storedBytes = 0
	for (const generation of generations) {
		for (const log of [0, 1] as const) {
			storedBytes += await fileSize(join(dir, runHistoryLogFile(generation, log)))
		}
	}
	const liveBytes = roots.length === 0 ? 0 : referencedBytes(roots)
	const dead = storedBytes - liveBytes
	if (dead <= liveBytes || dead < (options.minReclaimBytes ?? RUN_HISTORY_MIN_RECLAIM_BYTES)) {
		return { storedBytes, liveBytes, compacted: false }
	}

	const ordered = [...roots].sort((a, b) => a.order - b.order)
	const source = loadRunHistory(runDir)
	const resolved: { root: RunHistoryRoot; lines: Buffer[]; keys: string[] }[] = []
	for (const root of ordered) {
		const lines = await resolveLines(root.ref, source, root.file)
		resolved.push({ root, lines, keys: lines.map((line) => sha256(line)) })
	}

	const next = (generations.at(-1) as number) + 1
	const placed = new Map<string, Placed>()
	const buffers: [Buffer[], Buffer[]] = [[], []]
	const cursor = [0, 0]
	for (const { lines, keys } of resolved) {
		const plan = planAppends(keys, (key) => placed.has(key))
		plan.forEach((log, i) => {
			if (log === undefined) return
			const line = lines[i] as Buffer
			placed.set(keys[i] as string, {
				log,
				offset: cursor[log] as number,
				length: line.length,
			})
			buffers[log].push(line)
			cursor[log] = (cursor[log] as number) + line.length
		})
	}

	for (const log of [0, 1] as const) {
		const target = join(dir, runHistoryLogFile(next, log))
		const temporary = temporaryPathFor(target)
		const handle = await open(temporary, 'w')
		try {
			await handle.write(Buffer.concat(buffers[log]))
			// Synced, unlike an append: the older generations are deleted once
			// every record points here, so these bytes must outlive a power
			// loss before that happens. Compaction is rare; the cost is not.
			await handle.datasync()
		} finally {
			await handle.close()
		}
		await rename(temporary, target)
	}
	// The renames that name the new generation, before any record points at it.
	await syncDirectory(dir)

	for (const { root, keys } of resolved) {
		await root.rewrite({
			format: RUN_HISTORY_FORMAT,
			generation: next,
			count: root.ref.count,
			sha256: root.ref.sha256,
			segments: toSegments(keys, (key) => placed.get(key), dir),
		})
	}

	for (const generation of generations) {
		for (const log of [0, 1] as const) {
			await unlink(join(dir, runHistoryLogFile(generation, log))).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			})
		}
	}

	return { storedBytes, liveBytes, compacted: true }
}
