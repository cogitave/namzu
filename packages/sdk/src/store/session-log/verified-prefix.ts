import * as crypto from 'node:crypto'
import type { SessionId } from '../../types/ids/index.js'
import type { RecordPointer } from '../../types/session/records.js'
import { LineSplitter, type LogBytes, type SessionLogEntry } from './chain.js'
import { SessionTurnState } from './fold.js'

/**
 * What this process has already verified of a session log, so that checking
 * it again costs the bytes and not the parsing.
 *
 * A ledger remembers, for every record this process verified IN FULL (schema,
 * parse, hash chain, seq, gen, links: everything `SessionLogChain.accept`
 * checks), the byte length of its line and the SHA-256 of those bytes, plus
 * the head pointer, the `gen`, the session id and the turn state folded to
 * the head. A later claim of the same log reads every byte again and hashes
 * each line; a line whose length and digest equal the remembered ones is
 * byte-identical to a line that already passed every rule, so it passes them
 * again without being parsed. Only what lies after the remembered head is
 * verified in full. Nothing about the file's identity is trusted for
 * soundness: the content is compared. Any difference (a changed byte, a
 * shorter file, a replaced file, a line that no longer splits the same way)
 * makes the caller discard the ledger and verify from byte 0 as before.
 *
 * A ledger is fed only from entries that came out of a full verification and
 * that continue it (`seq` = count + 1 and `prev` equal to the head), so what
 * it holds is a prefix of one valid chain and nothing else. It costs 36 bytes
 * per record.
 */

const DIGEST_BYTES = 32
/** Logs kept; the least recently used is dropped. */
const LEDGERS_KEPT = 16
/** A log with more records than this is not remembered (about 72 MB of digests). */
const MAX_RECORDS = 1 << 21

/**
 * The digest of one line as lowercase hex. A string, not a Buffer: a Buffer per
 * line (82,000 of them in a long log) is native memory the collector has to
 * chase, and measured about twice the CPU. The one-shot form where Node has it.
 */
const hexDigestOf: (line: Uint8Array) => string =
	typeof crypto.hash === 'function'
		? (line) => crypto.hash('sha256', line, 'hex')
		: (line) => crypto.createHash('sha256').update(line).digest('hex')

/** Whether `hex` (64 lowercase hex characters) spells the 32 bytes at `at` in `bytes`. */
function hexEqualsBytes(hex: string, bytes: Uint8Array, at: number): boolean {
	if (hex.length !== DIGEST_BYTES * 2) return false
	for (let i = 0; i < DIGEST_BYTES; i++) {
		const high = hex.charCodeAt(i * 2)
		const low = hex.charCodeAt(i * 2 + 1)
		const value =
			((high <= 0x39 ? high - 0x30 : high - 0x57) << 4) | (low <= 0x39 ? low - 0x30 : low - 0x57)
		if (value !== bytes[at + i]) return false
	}
	return true
}

export class VerifiedPrefix {
	#count = 0
	#lengths = new Uint32Array(1024)
	#digests = Buffer.allocUnsafe(1024 * DIGEST_BYTES)
	#head: RecordPointer | null = null
	#gen = 0
	#sessionId: SessionId | undefined
	#end = 0
	#dead = false
	readonly #turns = new SessionTurnState()

	/** Records remembered. */
	get count(): number {
		return this.#count
	}
	get head(): RecordPointer | null {
		return this.#head
	}
	get gen(): number {
		return this.#gen
	}
	get sessionId(): SessionId | undefined {
		return this.#sessionId
	}
	/** Byte offset just after the last remembered record. */
	get end(): number {
		return this.#end
	}
	/** The turn state at the head, as its own copy. */
	turns(): SessionTurnState {
		return this.#turns.clone()
	}
	/** Lengths and digests as they stand now; entries below `count` never change. */
	get lengths(): Uint32Array {
		return this.#lengths
	}
	get digests(): Buffer {
		return this.#digests
	}

	/** Whether the remembered record `seq` is exactly `pointer` (length and digest). */
	holds(pointer: RecordPointer): boolean {
		const at = pointer.seq - 1
		if (at < 0 || at >= this.#count) return false
		if (this.#lengths[at] !== pointer.length) return false
		return (
			this.#digests.toString('hex', at * DIGEST_BYTES, (at + 1) * DIGEST_BYTES) === pointer.sha256
		)
	}

	/**
	 * Remember a record that was verified in full. Ignored unless it continues
	 * what is held: the next seq, naming the head by its pointer.
	 */
	append(entry: SessionLogEntry): void {
		if (this.#dead) return
		const { record, pointer } = entry
		if (pointer.seq !== this.#count + 1 || pointer.offset !== this.#end) return
		const prev = record.prev
		if (this.#head === null ? prev !== null : !samePointer(prev, this.#head)) return
		if (this.#sessionId !== undefined && record.sessionId !== this.#sessionId) return
		if (this.#count >= MAX_RECORDS) {
			this.#dead = true
			return
		}
		if (this.#count === this.#lengths.length) {
			const lengths = new Uint32Array(this.#lengths.length * 2)
			lengths.set(this.#lengths)
			this.#lengths = lengths
			const digests = Buffer.allocUnsafe(this.#digests.length * 2)
			this.#digests.copy(digests)
			this.#digests = digests
		}
		this.#lengths[this.#count] = pointer.length
		this.#digests.write(pointer.sha256, this.#count * DIGEST_BYTES, DIGEST_BYTES, 'hex')
		this.#count += 1
		this.#head = pointer
		this.#gen = record.gen
		this.#end = pointer.offset + pointer.length
		this.#sessionId ??= record.sessionId
		this.#turns.apply(record)
	}
}

function samePointer(a: RecordPointer | null | undefined, b: RecordPointer): boolean {
	return (
		a !== null &&
		a !== undefined &&
		a.seq === b.seq &&
		a.offset === b.offset &&
		a.length === b.length &&
		a.sha256 === b.sha256
	)
}

const ledgers = new Map<string, VerifiedPrefix>()

/** The ledger of a log, if this process has one; marks it recently used. */
export function verifiedPrefixOf(key: string): VerifiedPrefix | undefined {
	const found = ledgers.get(key)
	if (found !== undefined) {
		ledgers.delete(key)
		ledgers.set(key, found)
	}
	return found
}

/** Discard what is remembered of a log and start an empty ledger for it. */
export function startVerifiedPrefix(key: string): VerifiedPrefix {
	ledgers.delete(key)
	if (ledgers.size >= LEDGERS_KEPT) {
		const oldest = ledgers.keys().next().value
		if (oldest !== undefined) ledgers.delete(oldest)
	}
	const fresh = new VerifiedPrefix()
	ledgers.set(key, fresh)
	return fresh
}

/** Forget every remembered log: what a process that has not read them yet looks like. For tests. */
export function clearVerifiedPrefixes(): void {
	ledgers.clear()
}

/** How many logs are remembered. For tests. */
export function verifiedPrefixCount(): number {
	return ledgers.size
}

/**
 * Read the first `count` lines of `bytes` and compare each one's length and
 * SHA-256 with the ledger's. Resolves `true` only when every one is equal.
 * Parses nothing and keeps nothing. Any difference, a log that ends sooner,
 * or a fragment no record could be, resolves `false`: the caller then verifies
 * in full, which says what is wrong.
 */
export async function rehashPrefix(
	bytes: Pick<LogBytes, 'size'> & { stream(offset: number): AsyncIterable<Uint8Array> },
	ledger: VerifiedPrefix,
	count: number,
): Promise<boolean> {
	if (count === 0) return true
	if (count > ledger.count) return false
	const lengths = ledger.lengths
	const digests = ledger.digests
	if ((await bytes.size()) < endOfLine(lengths, count)) return false
	const splitter = new LineSplitter(0)
	let index = 0
	try {
		for await (const chunk of bytes.stream(0)) {
			for (const { line } of splitter.push(chunk)) {
				if (line.byteLength !== lengths[index]) return false
				if (!hexEqualsBytes(hexDigestOf(line), digests, index * DIGEST_BYTES)) return false
				index += 1
				if (index === count) return true
			}
		}
	} catch (error) {
		// A fragment longer than any record can be: not the log that was verified.
		if ((error as { name?: string }).name === 'SessionLogIntegrityError') return false
		throw error
	}
	return false
}

function endOfLine(lengths: Uint32Array, count: number): number {
	let total = 0
	for (let i = 0; i < count; i++) total += lengths[i] as number
	return total
}
