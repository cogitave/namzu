import { createHash } from 'node:crypto'
import { type FileHandle, appendFile, open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '../../types/message/index.js'

/**
 * One run's checkpoint message history, stored once.
 *
 * ## Why this exists
 *
 * A checkpoint used to carry the whole conversation inline. The run takes one
 * every iteration (and another at every tool review), so an N-iteration run
 * wrote the history N times over — quadratic in the run's length. Measured on
 * one machine before it was cleaned: 19,014 checkpoint files, 6.33 GB, one run
 * alone holding 532 checkpoints of about 1.5 MB each. Nearly every byte was a
 * message that the previous checkpoint had already written.
 *
 * Now every distinct message is appended to `checkpoints/history.jsonl` once,
 * one JSON value per line, and a checkpoint records WHICH lines make up its
 * history: runs of consecutive lines (`[log, offset, length, count]`), the
 * total count, and a SHA-256 over exactly those bytes in order.
 *
 * There are two logs, and which one a new message goes to is what keeps a
 * reference short. A message that extends the history — part of the run of
 * new messages at its END — goes to `history.jsonl`, so the history the run
 * keeps appending to stays one contiguous range there. A new message anywhere
 * else is an EDIT: the working-memory slot a pinned fact rewrites every
 * iteration, the summary a compaction puts where the head used to be. Those go
 * to `history-edits.jsonl`. With one log, each iteration's rewritten pin landed
 * between that iteration's messages and the next, and every later checkpoint
 * needed one range per iteration to step around them; with two, a pinned run
 * references three ranges however long it runs.
 *
 * ## What it keeps from the inline format
 *
 * - **Refusal over a silent partial read.** The digest covers the referenced
 *   bytes, so a truncated, edited or missing log refuses the checkpoint the
 *   same way a damaged inline one is refused — a resume must never continue
 *   from a history it cannot vouch for.
 * - **Old checkpoints read unchanged.** A checkpoint that carries `messages`
 *   inline is read exactly as before; only new writes use the log.
 * - **The public shape.** Readers still get an `IterationCheckpoint` with its
 *   `messages`; this is how the disk store lays bytes out, not a new contract.
 *
 * ## Concurrency
 *
 * Several stores can be bound to one run directory — in one process (the
 * run's own persistence and a resume's store) or across processes (a claim
 * handoff). Appends go through `O_APPEND` in one write, so they never
 * interleave inside a line; offsets are taken from the file size observed
 * immediately after the write. When that size is not the one this writer
 * predicted, somebody else appended in between, and the index is rebuilt
 * from the file rather than trusted — the one answer that is right whatever
 * the interleaving was.
 */

export const CHECKPOINT_HISTORY_FORMAT = 'namzu.checkpoint-history.v1'

/**
 * The run's two history logs, in `checkpoints/`, by index: `0` the history as
 * it grows, `1` the messages that replaced or were inserted into it.
 */
export const CHECKPOINT_HISTORY_FILES = ['history.jsonl', 'history-edits.jsonl'] as const

type LogIndex = 0 | 1

/** `[log, byte offset, byte length, line count]` of consecutive lines of one log. */
export type CheckpointHistorySegment = readonly [LogIndex, number, number, number]

/** What a checkpoint file stores in place of its `messages`. */
export interface CheckpointHistoryRef {
	readonly format: typeof CHECKPOINT_HISTORY_FORMAT
	readonly count: number
	/** SHA-256 (hex) of every referenced line, newline included, in order. */
	readonly sha256: string
	readonly segments: readonly CheckpointHistorySegment[]
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

/** Structural check of a parsed `history` field. */
export function isCheckpointHistoryRef(value: unknown): value is CheckpointHistoryRef {
	if (value === null || typeof value !== 'object') return false
	const ref = value as Record<string, unknown>
	if (ref.format !== CHECKPOINT_HISTORY_FORMAT) return false
	if (!isNonNegativeInteger(ref.count)) return false
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

/**
 * One append-only log and the index of what it holds.
 *
 * The index maps a line's digest to where it sits, and is rebuilt from the
 * file whenever the file is not the length this writer last left it.
 */
class LogFile {
	readonly path: string
	index = new Map<string, Location>()
	private end = 0
	private loaded = false

	constructor(path: string) {
		this.path = path
	}

	get length(): number {
		return this.end
	}

	/** Bring the index up to the file's current length. */
	async catchUp(): Promise<void> {
		if (!this.loaded || (await fileSize(this.path)) !== this.end) await this.rebuild()
	}

	/**
	 * Append `lines`, which the caller placed from {@link length} onward, and
	 * index them. Returns whether the prediction held; when it did not,
	 * another writer appended in between and the index was rebuilt from the
	 * file, which is right whatever the interleaving was.
	 */
	async append(lines: readonly Buffer[], predicted: ReadonlyMap<string, Location>): Promise<void> {
		const expected = this.end + lines.reduce((n, line) => n + line.length, 0)
		const handle = await open(this.path, 'a')
		try {
			await handle.write(Buffer.concat(lines))
			// The checkpoint that references these bytes is published right
			// after this, so they have to be on disk before it is.
			await handle.datasync()
		} finally {
			await handle.close()
		}
		if ((await stat(this.path)).size !== expected) {
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
		this.loaded = true
	}
}

/**
 * The append side, bound to one run's `checkpoints/` directory.
 *
 * A message already in either log is referenced rather than written again.
 */
export class CheckpointHistoryLog {
	private readonly logs: readonly [LogFile, LogFile]
	private lock: Promise<void> = Promise.resolve()

	constructor(checkpointsDir: string) {
		this.logs = [
			new LogFile(join(checkpointsDir, CHECKPOINT_HISTORY_FILES[0])),
			new LogFile(join(checkpointsDir, CHECKPOINT_HISTORY_FILES[1])),
		]
	}

	/** Make sure every message is in a log and return the reference to them. */
	record(messages: readonly Message[]): Promise<CheckpointHistoryRef> {
		const next = this.lock.then(() => this.recordLocked(messages))
		this.lock = next.then(
			() => {},
			() => {},
		)
		return next
	}

	private find(key: string): Placed | undefined {
		for (const log of [0, 1] as const) {
			const location = this.logs[log].index.get(key)
			if (location) return { log, ...location }
		}
		return undefined
	}

	private async recordLocked(messages: readonly Message[]): Promise<CheckpointHistoryRef> {
		await Promise.all(this.logs.map((log) => log.catchUp()))

		const lines = messages.map((message) => Buffer.from(`${JSON.stringify(message) ?? 'null'}\n`))
		const whole = createHash('sha256')
		const keys = lines.map((line) => {
			whole.update(line)
			return sha256(line)
		})

		// Where the run of new messages at the end begins. Those extend the
		// history; any other new message is an edit of it.
		let tail = lines.length
		while (tail > 0 && !this.find(keys[tail - 1] as string)) tail--

		const pending: [Buffer[], Buffer[]] = [[], []]
		const predicted: [Map<string, Location>, Map<string, Location>] = [new Map(), new Map()]
		const cursor = [this.logs[0].length, this.logs[1].length]
		for (let i = 0; i < lines.length; i++) {
			const key = keys[i] as string
			if (this.find(key) || predicted[0].has(key) || predicted[1].has(key)) continue
			const log: LogIndex = i >= tail ? 0 : 1
			const line = lines[i] as Buffer
			predicted[log].set(key, { offset: cursor[log] as number, length: line.length })
			pending[log].push(line)
			cursor[log] = (cursor[log] as number) + line.length
		}
		for (const log of [0, 1] as const) {
			if (pending[log].length > 0) await this.logs[log].append(pending[log], predicted[log])
		}

		const segments: [LogIndex, number, number, number][] = []
		for (const key of keys) {
			const placed = this.find(key)
			if (!placed) {
				throw new Error(
					`Checkpoint history in ${this.logs[0].path} lost a line it had just written; refusing to publish a checkpoint that references it.`,
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

		return {
			format: CHECKPOINT_HISTORY_FORMAT,
			count: lines.length,
			sha256: whole.digest('hex'),
			segments,
		}
	}
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
		throw error
	}
}

/**
 * Where a reader gets referenced bytes from.
 *
 * A listing reads each log once and slices it; a single read uses positional
 * reads so it does not load history no checkpoint of interest refers to.
 */
export interface CheckpointHistorySource {
	read(log: LogIndex, offset: number, length: number): Promise<Buffer>
	/** Parsed lines, by log and offset, shared by every checkpoint resolved from this source. */
	readonly parsed: Map<string, Message>
	close(): Promise<void>
}

/** Read each log once, for resolving many checkpoints. */
export async function loadCheckpointHistory(
	checkpointsDir: string,
): Promise<CheckpointHistorySource> {
	const raw: [Buffer | undefined, Buffer | undefined] = [undefined, undefined]
	return {
		parsed: new Map(),
		read: async (log, offset, length) => {
			let bytes = raw[log]
			if (bytes === undefined) {
				bytes = await readFile(join(checkpointsDir, CHECKPOINT_HISTORY_FILES[log]))
				raw[log] = bytes
			}
			return bytes.subarray(offset, offset + length)
		},
		close: async () => {},
	}
}

/** Positional reads against the logs, for resolving one checkpoint. */
export async function openCheckpointHistory(
	checkpointsDir: string,
): Promise<CheckpointHistorySource> {
	const handles: [FileHandle | undefined, FileHandle | undefined] = [undefined, undefined]
	return {
		parsed: new Map(),
		read: async (log, offset, length) => {
			let handle = handles[log]
			if (handle === undefined) {
				handle = await open(join(checkpointsDir, CHECKPOINT_HISTORY_FILES[log]), 'r')
				handles[log] = handle
			}
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, offset)
			return buffer.subarray(0, bytesRead)
		},
		close: async () => {
			await Promise.all(handles.map((handle) => handle?.close()))
		},
	}
}

/**
 * The messages a reference names, or a refusal.
 *
 * Refuses when a log is missing, shorter than the reference, or holds
 * different bytes than the ones the checkpoint was written against. A
 * checkpoint is read to RESUME from, so anything less than the exact history
 * it recorded has to stop the resume rather than feed it a different past.
 */
export async function resolveCheckpointHistory(
	ref: CheckpointHistoryRef,
	source: CheckpointHistorySource,
	file: string,
): Promise<Message[]> {
	const refuse = (why: string, cause?: unknown): never => {
		throw new Error(
			`Checkpoint file "${file}" references message history that ${why}. Refusing rather than resuming from a history it cannot vouch for.`,
			cause === undefined ? undefined : { cause },
		)
	}
	const whole = createHash('sha256')
	const messages: Message[] = []
	const used = new Set<string>()
	for (const [log, offset, length, count] of ref.segments) {
		let bytes: Buffer
		try {
			bytes = await source.read(log, offset, length)
		} catch (error) {
			return refuse(`cannot be read from ${CHECKPOINT_HISTORY_FILES[log]}`, error)
		}
		if (bytes.length !== length) {
			return refuse(`is shorter in ${CHECKPOINT_HISTORY_FILES[log]} than the checkpoint records`)
		}
		whole.update(bytes)
		let start = 0
		for (let i = 0; i < count; i++) {
			const newline = bytes.indexOf(0x0a, start)
			if (newline < 0) return refuse('does not hold the lines it records')
			const at = `${log}:${offset + start}`
			// Shared across the checkpoints of one listing, never within one
			// history: two equal messages in the same conversation stay two
			// objects, as they were when the history was stored inline.
			let message = used.has(at) ? undefined : source.parsed.get(at)
			if (message === undefined) {
				try {
					message = JSON.parse(bytes.subarray(start, newline).toString('utf8')) as Message
				} catch (error) {
					return refuse('holds a line that is not JSON', error)
				}
				if (!used.has(at)) source.parsed.set(at, message)
			}
			used.add(at)
			messages.push(message)
			start = newline + 1
		}
		if (start !== bytes.length) return refuse('does not hold the lines it records')
	}
	if (whole.digest('hex') !== ref.sha256) return refuse('does not match its digest')
	return messages
}
