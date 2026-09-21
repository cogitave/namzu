import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import type { CompactedToolMetadata } from './compaction-provenance.js'
import { compactedTexts } from './compaction-text.js'
import { digest, textFilter, tokenFilter } from './format.js'
import { type EvidenceBudget, RECORD_BYTES, decode, readBytes } from './io.js'

const integer = z.number().int().nonnegative().safe()
export const entrySchema = z.object({
	offset: integer,
	length: integer.max(RECORD_BYTES),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	seq: integer,
	/** The turn the record belongs to; absent for a record outside any turn. */
	turnId: z.string().uuid().optional(),
	source: z.enum([
		'tool_completed',
		'message_completed',
		'compaction_shed:system',
		'compaction_shed:summary',
		'compaction_shed:user',
		'compaction_shed:assistant',
		'compaction_shed:tool',
	]),
	part: integer.default(0),
	toolName: z.string().max(1024).optional(),
	toolUseId: z.string().max(1024).optional(),
	isError: z.boolean().optional(),
	truncated: z.boolean(),
	spill: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	filter: z.string().max(1400),
	tokenFilter: z.string().max(1400).optional(),
})
export type IndexEntry = z.infer<typeof entrySchema>
export const positionSchema = z.object({
	offset: integer,
	seq: integer,
	textIndex: integer.default(0),
})
export type IndexPosition = z.infer<typeof positionSchema>
export interface IndexPage {
	start: IndexPosition
	entries: IndexEntry[]
	next: IndexPosition | null
	records: number
}

/** Seals addresses and cursors to one scope and one state of the source. */
export interface EvidenceSeal {
	pack(value: unknown): string
	unpack(value: string): unknown
}

/**
 * The seal of one session log. Its key is derived from the log's first
 * record, so an address or cursor stays valid across a restart while the
 * source is unchanged, and never validates against another session.
 */
export function evidenceSeal(sessionStart: Uint8Array, sourceKey: string): EvidenceSeal {
	const key = createHash('sha256')
		.update('namzu-session-evidence-v1\n')
		.update(sessionStart)
		.digest()
	const mac = (value: string) => createHmac('sha256', key).update(`${sourceKey}\n${value}`).digest()
	return {
		pack(value) {
			const body = Buffer.from(JSON.stringify(value)).toString('base64url')
			return `${body}.${mac(body).toString('base64url')}`
		},
		unpack(value) {
			const [body, signature, extra] = value.split('.')
			if (!body || !signature || extra) throw new Error('Invalid evidence address.')
			const actual = Buffer.from(signature, 'base64url')
			if (actual.length !== 32 || !timingSafeEqual(actual, mac(body)))
				throw new Error('Evidence address belongs to a different scope or changed source.')
			return JSON.parse(decode(Buffer.from(body, 'base64url')))
		},
	}
}

export function toolEntry(
	record: Record<string, unknown>,
	offset: number,
	bytes: Buffer,
): IndexEntry | null {
	if (record.type !== 'tool_completed') return null
	if (
		typeof record.result !== 'string' ||
		typeof record.isError !== 'boolean' ||
		typeof record.toolName !== 'string' ||
		typeof record.toolUseId !== 'string'
	)
		throw new Error('Malformed tool evidence.')
	return entrySchema.parse({
		offset,
		length: bytes.length,
		sha256: digest(bytes),
		seq: record.seq,
		...(typeof record.turnId === 'string' ? { turnId: record.turnId } : {}),
		source: 'tool_completed',
		part: 0,
		toolName: record.toolName,
		toolUseId: record.toolUseId,
		isError: record.isError,
		truncated: record.outputTruncated === true,
		...(typeof record.outputSpillIntegrity === 'string'
			? { spill: record.outputSpillIntegrity }
			: {}),
		filter: textFilter(record.result),
		tokenFilter: tokenFilter(record.result),
	})
}

/** Validate all textual parts of a record before publishing any part of it. */
export function recordTexts(
	record: Record<string, unknown>,
): ({ source: string; text: string } & CompactedToolMetadata)[] {
	if (record.type === 'tool_completed') {
		if (typeof record.result !== 'string') throw new Error('Invalid tool text.')
		return [{ source: 'tool_completed', text: record.result }]
	}
	if (record.type === 'message_completed') {
		if (record.content === undefined) return []
		if (typeof record.content !== 'string') throw new Error('Invalid message text.')
		return [{ source: 'message_completed', text: record.content }]
	}
	if (record.type !== 'compaction_shed') return []
	return compactedTexts(record.messages).map(({ role, summary, ...part }) => ({
		source: `compaction_shed:${summary ? 'summary' : role}`,
		...part,
	}))
}

/**
 * Index the text of at most 64 records (64 textual parts, 4 MiB of input)
 * from `start`. Every record must belong to the session and continue the
 * log's seq; the first must be `session_started`.
 */
export async function indexPage(
	handle: FileHandle,
	size: number,
	sessionId: string,
	start: IndexPosition,
	budget: EvidenceBudget,
): Promise<{ page: IndexPage; cacheHit: boolean }> {
	let offset = start.offset
	let seq = start.seq
	let textIndex = start.textIndex
	let records = 0
	let buffered = Buffer.alloc(0)
	let readOffset = offset
	const entries: IndexEntry[] = []
	while (offset < size && records < 64 && entries.length < 64) {
		budget.signal?.throwIfAborted()
		let newline = buffered.indexOf(10)
		while (newline < 0) {
			if (buffered.length >= RECORD_BYTES || readOffset >= size)
				throw new Error('Oversized or torn session log record; history is incomplete.')
			const count = Math.min(65_536, size - readOffset, RECORD_BYTES - buffered.length)
			if (readOffset - start.offset + count > RECORD_BYTES && records > 0) break
			buffered = Buffer.concat([buffered, await readBytes(handle, readOffset, count, budget)])
			readOffset += count
			newline = buffered.indexOf(10)
		}
		if (newline < 0) break
		const raw = buffered.subarray(0, newline + 1)
		const record = JSON.parse(decode(raw)) as Record<string, unknown>
		if (
			record.sessionId !== sessionId ||
			record.seq !== seq + 1 ||
			typeof record.type !== 'string' ||
			(offset === 0 && record.type !== 'session_started')
		)
			throw new Error('Session log identity or record sequence is invalid.')
		const parts = recordTexts(record)
		if (textIndex > parts.length) throw new Error('Invalid textual part position.')
		const hash = digest(raw)
		const tool = toolEntry(record, offset, raw)
		records++
		while (textIndex < parts.length && entries.length < 64) {
			const part = parts[textIndex]
			if (!part) throw new Error('Invalid textual part.')
			entries.push(
				tool ??
					entrySchema.parse({
						offset,
						length: raw.length,
						sha256: hash,
						seq: record.seq,
						...(typeof record.turnId === 'string' ? { turnId: record.turnId } : {}),
						source: part.source,
						toolName: part.toolName,
						isError: part.isError,
						part: textIndex,
						truncated: false,
						filter: textFilter(part.text),
						tokenFilter: tokenFilter(part.text),
					}),
			)
			textIndex++
		}
		if (textIndex < parts.length) break
		textIndex = 0
		offset += raw.length
		seq++
		buffered = buffered.subarray(raw.length)
	}
	const page: IndexPage = {
		start,
		entries,
		records,
		next: offset < size ? { offset, seq, textIndex } : null,
	}
	return { page, cacheHit: false }
}
