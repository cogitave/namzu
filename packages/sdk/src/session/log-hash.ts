import { createHash } from 'node:crypto'
import {
	SESSION_RECORD_MAX_BYTES,
	type SessionRecord,
	SessionRecordSchema,
} from '../types/session/records.js'

/**
 * The byte-level rules of one session-log line, shared by the writer, the
 * reader and the index.
 *
 * A line is one record serialised as JSON and terminated by `\n`. Its hash is
 * the SHA-256 of exactly those bytes, the newline included, and a record's
 * `prev` pointer names the previous line by seq, byte offset, byte length and
 * that hash. Nothing is canonicalised: the bytes on disk are the bytes hashed.
 */

const NEWLINE = 0x0a
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function bytesOf(line: string | Uint8Array): Uint8Array {
	return typeof line === 'string' ? encoder.encode(line) : line
}

/** SHA-256 (lowercase hex) of one complete line, its terminating newline included. */
export function recordSha256(line: string | Uint8Array): string {
	return createHash('sha256').update(bytesOf(line)).digest('hex')
}

/** Serialise a record as the one line a log stores for it. */
export function formatSessionLogLine(record: SessionRecord): string {
	const line = `${JSON.stringify(record)}\n`
	const length = encoder.encode(line).byteLength
	if (length > SESSION_RECORD_MAX_BYTES) {
		throw new SessionLogLineError(
			'too-large',
			`A ${record.type} record is ${length} bytes; the limit is ${SESSION_RECORD_MAX_BYTES}. Spill the body to tool-results/ first.`,
		)
	}
	return line
}

export type SessionLogLineFault = 'torn' | 'too-large' | 'not-utf8' | 'not-json' | 'not-a-record'

/** One line that is not a complete, valid record. `fault` says which rule it broke. */
export class SessionLogLineError extends Error {
	override readonly name = 'SessionLogLineError'
	constructor(
		readonly fault: SessionLogLineFault,
		message: string,
	) {
		super(message)
	}
}

export interface ParsedSessionLogLine {
	readonly record: SessionRecord
	/** Bytes of the line, newline included: the `length` of a pointer to it. */
	readonly length: number
	readonly sha256: string
}

/**
 * Parse one complete line of a session log: exactly one record followed by
 * one `\n`. A line with no terminating newline is `torn` (a crash mid-append);
 * the reader, not this function, decides to truncate it.
 */
export function parseSessionLogLine(line: string | Uint8Array): ParsedSessionLogLine {
	const bytes = bytesOf(line)
	if (bytes.byteLength > SESSION_RECORD_MAX_BYTES) {
		throw new SessionLogLineError(
			'too-large',
			`A session-log line is ${bytes.byteLength} bytes; the limit is ${SESSION_RECORD_MAX_BYTES}.`,
		)
	}
	const end = bytes.indexOf(NEWLINE)
	if (end !== bytes.byteLength - 1) {
		throw new SessionLogLineError(
			'torn',
			end === -1
				? 'The line has no terminating newline: the record was cut off mid-append.'
				: 'The line holds more than one record.',
		)
	}
	let text: string
	try {
		text = decoder.decode(bytes.subarray(0, end))
	} catch {
		throw new SessionLogLineError('not-utf8', 'The line is not valid UTF-8.')
	}
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (error) {
		throw new SessionLogLineError(
			'not-json',
			`The line is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const parsed = SessionRecordSchema.safeParse(value)
	if (!parsed.success) {
		throw new SessionLogLineError(
			'not-a-record',
			`The line is not a session record: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.') || '(record)'}: ${issue.message}`)
				.join('; ')}`,
		)
	}
	return {
		record: parsed.data as SessionRecord,
		length: bytes.byteLength,
		sha256: recordSha256(bytes),
	}
}
