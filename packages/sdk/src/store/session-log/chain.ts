import { SessionLogLineError, parseSessionLogLine, recordSha256 } from '../../session/log-hash.js'
import type { SessionId } from '../../types/ids/index.js'
import {
	type RecordPointer,
	SESSION_RECORD_MAX_BYTES,
	type SessionRecord,
} from '../../types/session/records.js'

/**
 * The hash chain of one session log.
 *
 * Every record names its predecessor by `prev`: seq, byte offset, byte length
 * (newline included) and the SHA-256 of exactly those bytes. Verifying a log
 * is walking it line by line and checking that each `prev` is the pointer of
 * the line before it. Moved here from `store/evidence/record-chain.ts`, whose
 * predecessor and text-link rules it keeps, under the session envelope's
 * names (`prev`, `prevText`).
 *
 * The rules:
 *
 * - Seq 1 is `session_started`, at offset 0, with `prev: null`.
 * - Every later record has `seq = previous seq + 1` and a `prev` equal, field
 *   by field, to the previous line's pointer. A flipped byte in any line
 *   changes that line's hash, so the NEXT record's `prev` no longer matches.
 * - Every record names the same session as the first.
 * - `gen` never decreases: a record written under an older lease after one
 *   written under a newer lease is a split writer, not a log.
 * - `prevText`, when present, is a skip link to an earlier text-bearing
 *   record: `null` only where `prev` is `null`, otherwise strictly before the
 *   record, and equal to `prev` when it names the same seq.
 *
 * The last record has no successor to vouch for it. A reader that needs the
 * tail anchored passes the head it expects (an index row, a checkpoint's
 * `throughSha256`) and the read refuses a log that does not hold it.
 */

/** One record of a log, with the pointer to its own bytes. */
export interface SessionLogEntry {
	readonly record: SessionRecord
	readonly pointer: RecordPointer
}

export type SessionLogBreakReason =
	| 'not-a-record'
	| 'bad-start'
	| 'seq-gap'
	| 'prev-mismatch'
	| 'session-mismatch'
	| 'gen-regressed'
	| 'bad-text-link'
	| 'anchor-mismatch'

/** A log that is not an unbroken chain. `seq` and `offset` name where the break is. */
export class SessionLogIntegrityError extends Error {
	override readonly name = 'SessionLogIntegrityError'
	constructor(
		readonly reason: SessionLogBreakReason,
		/** The seq the reader expected at the break. */
		readonly seq: number,
		/** Byte offset of the line that broke the chain. */
		readonly offset: number,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

function samePointer(a: RecordPointer | null | undefined, b: RecordPointer | null): boolean {
	if (a === null || a === undefined || b === null) return a === b
	return a.seq === b.seq && a.offset === b.offset && a.length === b.length && a.sha256 === b.sha256
}

/** Where a chain walk starts: the beginning of the log, or just after a known record. */
export interface ChainStart {
	/** The last verified record; `null` (the default) starts at offset 0. */
	readonly head: RecordPointer | null
	/** The session every record must name; learnt from seq 1 when omitted. */
	readonly sessionId?: SessionId
	/** The `gen` of the record at `head`. */
	readonly gen?: number
}

/**
 * Verifies a log one line at a time. Throws {@link SessionLogIntegrityError}
 * at the first line that breaks the chain; the state is then unchanged, so a
 * tolerant reader can stop there with everything before it intact.
 */
export class SessionLogChain {
	#head: RecordPointer | null
	#sessionId: SessionId | undefined
	#gen: number

	constructor(start: ChainStart = { head: null }) {
		this.#head = start.head
		this.#sessionId = start.sessionId
		this.#gen = start.gen ?? 0
	}

	get head(): RecordPointer | null {
		return this.#head
	}

	get sessionId(): SessionId | undefined {
		return this.#sessionId
	}

	get gen(): number {
		return this.#gen
	}

	/** The byte offset the next line must start at. */
	get end(): number {
		return this.#head === null ? 0 : this.#head.offset + this.#head.length
	}

	/** Verify one complete line (newline included) found at `offset`. */
	accept(line: Uint8Array, offset: number): SessionLogEntry {
		const expectedSeq = (this.#head?.seq ?? 0) + 1
		const fail = (reason: SessionLogBreakReason, message: string, cause?: unknown): never => {
			throw new SessionLogIntegrityError(
				reason,
				expectedSeq,
				offset,
				`Session log breaks at seq ${expectedSeq} (byte ${offset}): ${message}`,
				cause === undefined ? undefined : { cause },
			)
		}
		if (offset !== this.end) {
			fail(
				'seq-gap',
				`the line starts at byte ${offset}, not at ${this.end} where the last one ended`,
			)
		}
		let parsed: ReturnType<typeof parseSessionLogLine>
		try {
			parsed = parseSessionLogLine(line)
		} catch (error) {
			return fail(
				'not-a-record',
				error instanceof SessionLogLineError ? error.message : String(error),
				error,
			)
		}
		const { record } = parsed
		const pointer: RecordPointer = {
			seq: record.seq,
			offset,
			length: parsed.length,
			sha256: parsed.sha256,
		}
		if (this.#head === null) {
			if (offset !== 0 || record.seq !== 1 || record.type !== 'session_started') {
				fail('bad-start', 'a session log starts with session_started at seq 1, offset 0')
			}
		} else {
			if (record.seq !== expectedSeq) fail('seq-gap', `the record says seq ${record.seq}`)
			if (!samePointer(record.prev, this.#head)) {
				fail(
					'prev-mismatch',
					'its prev pointer does not name the bytes of the record before it (that record, or this pointer, was altered)',
				)
			}
		}
		if (this.#sessionId !== undefined && record.sessionId !== this.#sessionId) {
			fail(
				'session-mismatch',
				`the record names session ${record.sessionId}, not ${this.#sessionId}`,
			)
		}
		if (record.gen < this.#gen) {
			fail(
				'gen-regressed',
				`gen ${record.gen} follows gen ${this.#gen}: a writer whose lease had been superseded appended after its successor`,
			)
		}
		checkTextLink(record, pointer, fail)
		this.#head = pointer
		this.#sessionId ??= record.sessionId
		this.#gen = record.gen
		return { record, pointer }
	}
}

/**
 * The text-link rules, salvaged from `recordPredecessors`: a skip link may
 * pass over operational records, but never past the start of the log and
 * never forward.
 */
function checkTextLink(
	record: SessionRecord,
	pointer: RecordPointer,
	fail: (reason: SessionLogBreakReason, message: string) => never,
): void {
	if (!Object.hasOwn(record, 'prevText')) return
	const next = record.prevText ?? null
	const previous = record.prev
	if (
		(next === null && previous !== null) ||
		(next !== null &&
			(previous === null ||
				next.seq >= pointer.seq ||
				next.offset + next.length > pointer.offset ||
				(next.seq === previous.seq && !samePointer(next, previous))))
	) {
		fail('bad-text-link', 'its prevText skip link does not name an earlier record')
	}
}

/**
 * Splits a byte stream into complete lines, carrying a partial line across
 * chunks. Whatever is left at the end with no newline is the torn tail.
 */
export class LineSplitter {
	#pending: Uint8Array[] = []
	#pendingBytes = 0
	#offset = 0

	constructor(startOffset = 0) {
		this.#offset = startOffset
	}

	/** Bytes held after the last complete line. */
	get pendingBytes(): number {
		return this.#pendingBytes
	}

	*push(chunk: Uint8Array): Generator<{ line: Uint8Array; offset: number }> {
		let start = 0
		for (;;) {
			const newline = chunk.indexOf(0x0a, start)
			if (newline === -1) break
			let line = chunk.subarray(start, newline + 1)
			if (this.#pendingBytes > 0) {
				line = Buffer.concat([...this.#pending, line])
				this.#pending = []
				this.#pendingBytes = 0
			}
			yield { line, offset: this.#offset }
			this.#offset += line.byteLength
			start = newline + 1
		}
		if (start < chunk.byteLength) {
			// Copied: the caller may reuse the chunk's buffer for its next read.
			const rest = Uint8Array.prototype.slice.call(chunk, start)
			this.#pending.push(rest)
			this.#pendingBytes += rest.byteLength
			if (this.#pendingBytes > SESSION_RECORD_MAX_BYTES) {
				// A fragment longer than any record can be is not a line in progress.
				throw new SessionLogIntegrityError(
					'not-a-record',
					0,
					this.#offset,
					`Session log holds ${this.#pendingBytes} bytes at byte ${this.#offset} without a newline; no record is that long.`,
				)
			}
		}
	}
}

/** Random access to a log's bytes, as both backends provide it. */
export interface LogBytes {
	size(): Promise<number>
	read(offset: number, length: number): Promise<Uint8Array>
}

/**
 * The last complete record of a log, read from its tail only: never the whole
 * log. Salvaged from `transcriptTail`. Returns `undefined` for an empty log,
 * or when the tail is torn or does not parse — the caller then scans.
 *
 * Unverified: the record's own `prev` is not checked against the line before
 * it. It bootstraps a head cheaply; a writer re-verifies before appending.
 */
export async function readSessionLogTail(
	bytes: LogBytes,
): Promise<{ entry: SessionLogEntry; size: number } | undefined> {
	const size = await bytes.size()
	if (size === 0) return undefined
	const offset = Math.max(0, size - SESSION_RECORD_MAX_BYTES - 1)
	const tail = await bytes.read(offset, size - offset)
	if (tail.at(-1) !== 0x0a) return undefined
	const start = tail.lastIndexOf(0x0a, tail.byteLength - 2) + 1
	if (start === 0 && offset !== 0) return undefined
	const raw = tail.subarray(start)
	try {
		const parsed = parseSessionLogLine(raw)
		return {
			entry: {
				record: parsed.record,
				pointer: {
					seq: parsed.record.seq,
					offset: offset + start,
					length: parsed.length,
					sha256: parsed.sha256,
				},
			},
			size,
		}
	} catch {
		return undefined
	}
}

/**
 * Check that the bytes at `pointer` are exactly the record it names. Used to
 * resume a walk from a cursor, and to anchor a tail.
 */
export async function verifyPointer(bytes: LogBytes, pointer: RecordPointer): Promise<boolean> {
	const size = await bytes.size()
	if (pointer.offset + pointer.length > size) return false
	const raw = await bytes.read(pointer.offset, pointer.length)
	return raw.byteLength === pointer.length && recordSha256(raw) === pointer.sha256
}
