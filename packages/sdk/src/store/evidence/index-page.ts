import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { link, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { compactionArchiveSchema } from './compaction-archive.js'
import { digest, textFilter } from './format.js'
import {
	type EvidenceBudget,
	EvidencePageLimit,
	RECORD_BYTES,
	decode,
	noLinks,
	readBytes,
	readSmall,
} from './io.js'

const integer = z.number().int().nonnegative().safe()
export const entrySchema = z.object({
	offset: integer,
	length: integer.max(RECORD_BYTES),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	seq: integer,
	source: z.enum([
		'tool_completed',
		'message_completed',
		'compaction_shed:system',
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
})
export type IndexEntry = z.infer<typeof entrySchema>
export const positionSchema = z.object({
	offset: integer,
	seq: integer,
	textIndex: integer.default(0),
})
export type IndexPosition = z.infer<typeof positionSchema>
const pageSchema = z.object({
	start: positionSchema,
	entries: z.array(entrySchema).max(64),
	next: positionSchema.nullable(),
	records: integer.max(64),
})
export type IndexPage = z.infer<typeof pageSchema>

export interface EvidenceSeal {
	pack(value: unknown): string
	unpack(value: string): unknown
	dir: string
}

export async function evidenceSeal(
	root: string,
	scopeKey: string,
	sourceKey: string,
	budget: EvidenceBudget,
): Promise<EvidenceSeal> {
	try {
		await noLinks(root)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		await noLinks(dirname(root))
		try {
			await mkdir(root, { mode: 0o700 })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		await noLinks(root)
	}
	const dir = join(root, scopeKey)
	await mkdir(dir, { mode: 0o700, recursive: true })
	await noLinks(dir)
	const keyPath = join(dir, 'key')
	let key: Buffer
	try {
		key = await readSmall(keyPath, budget, 32)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		const candidate = `${keyPath}.${randomBytes(8).toString('hex')}.tmp`
		await writeFile(candidate, randomBytes(32), { flag: 'wx', mode: 0o600 })
		try {
			try {
				await link(candidate, keyPath)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			}
		} finally {
			await unlink(candidate)
		}
		key = await readSmall(keyPath, budget, 32)
	}
	if (key.length !== 32) throw new Error('Incomplete evidence index key.')
	const mac = (value: string) => createHmac('sha256', key).update(`${sourceKey}\n${value}`).digest()
	return {
		dir,
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
	event: Record<string, unknown>,
	offset: number,
	bytes: Buffer,
): IndexEntry | null {
	if (event.type !== 'tool_completed') return null
	if (
		typeof event.result !== 'string' ||
		typeof event.isError !== 'boolean' ||
		typeof event.toolName !== 'string' ||
		typeof event.toolUseId !== 'string'
	)
		throw new Error('Malformed tool evidence.')
	return entrySchema.parse({
		offset,
		length: bytes.length,
		sha256: digest(bytes),
		seq: event.seq,
		source: 'tool_completed',
		part: 0,
		toolName: event.toolName,
		toolUseId: event.toolUseId,
		isError: event.isError,
		truncated: event.outputTruncated === true,
		...(typeof event.outputSpillIntegrity === 'string'
			? { spill: event.outputSpillIntegrity }
			: {}),
		filter: textFilter(event.result),
	})
}

/** Validate all textual parts before publishing any part of a record. */
export function eventTexts(event: Record<string, unknown>): { source: string; text: string }[] {
	if (event.type === 'compaction_archive') {
		return compactionArchiveSchema.parse(event).archive.parts.map((part) => ({
			source: `compaction_shed:${part.role}`,
			text: '',
		}))
	}
	if (event.type === 'tool_completed') {
		if (typeof event.result !== 'string') throw new Error('Invalid tool text.')
		return [{ source: 'tool_completed', text: event.result }]
	}
	if (event.type === 'message_completed') {
		if (event.content === undefined) return []
		if (typeof event.content !== 'string') throw new Error('Invalid message text.')
		return [{ source: 'message_completed', text: event.content }]
	}
	if (event.type !== 'compaction_shed') return []
	if (!Array.isArray(event.messages)) throw new Error('Invalid shed messages.')
	const parts: { source: string; text: string }[] = []
	for (const message of event.messages) {
		if (
			!message ||
			typeof message !== 'object' ||
			typeof message.role !== 'string' ||
			!['system', 'user', 'assistant', 'tool'].includes(message.role)
		)
			throw new Error('Invalid shed message.')
		if (typeof message.content === 'string')
			parts.push({ source: `compaction_shed:${message.role}`, text: message.content })
	}
	return parts
}

/** Each cache page indexes at most 64 records, 64 textual parts and 4 MiB of input. */
export async function indexPage(
	handle: FileHandle,
	size: number,
	runId: string,
	start: IndexPosition,
	seal: EvidenceSeal,
	sourceKey: string,
	budget: EvidenceBudget,
): Promise<{ page: IndexPage; cacheHit: boolean }> {
	const path = join(
		seal.dir,
		`${digest(`${sourceKey}:${start.offset}:${start.seq}:${start.textIndex}`)}.page`,
	)
	try {
		const cached = await readSmall(path, budget, 512 * 1024)
		const page = pageSchema.parse(seal.unpack(decode(cached)))
		if (
			page.start.offset !== start.offset ||
			page.start.seq !== start.seq ||
			page.start.textIndex !== start.textIndex
		)
			throw new Error('Index page position mismatch.')
		return { page, cacheHit: true }
	} catch (error) {
		budget.signal?.throwIfAborted()
		if (error instanceof EvidencePageLimit) throw error
		// The cache is disposable. A missing, damaged or incompatible page is rebuilt.
	}
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
				throw new Error('Oversized or torn transcript record; history is incomplete.')
			const count = Math.min(65_536, size - readOffset, RECORD_BYTES - buffered.length)
			if (readOffset - start.offset + count > RECORD_BYTES && records > 0) break
			buffered = Buffer.concat([buffered, await readBytes(handle, readOffset, count, budget)])
			readOffset += count
			newline = buffered.indexOf(10)
		}
		if (newline < 0) break
		const raw = buffered.subarray(0, newline + 1)
		const event = JSON.parse(decode(raw)) as Record<string, unknown>
		if (
			event.runId !== runId ||
			event.seq !== seq + 1 ||
			typeof event.type !== 'string' ||
			(offset === 0 && event.type !== 'run_started')
		)
			throw new Error('Transcript identity or event sequence is invalid.')
		const parts = eventTexts(event)
		const archive =
			event.type === 'compaction_archive' ? compactionArchiveSchema.parse(event) : undefined
		if (textIndex > parts.length) throw new Error('Invalid textual part position.')
		const hash = digest(raw)
		const tool = toolEntry(event, offset, raw)
		records++
		while (textIndex < parts.length && entries.length < 64) {
			const part = parts[textIndex]
			if (!part) throw new Error('Invalid textual part.')
			const archivedPart = archive?.archive.parts[textIndex]
			if (archive && !archivedPart) throw new Error('Missing archived text part.')
			entries.push(
				tool ??
					entrySchema.parse({
						offset,
						length: raw.length,
						sha256: hash,
						seq: event.seq,
						source: part.source,
						part: textIndex,
						truncated: false,
						...(archivedPart ? { spill: archivedPart.manifest } : {}),
						filter: textFilter(part.text),
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
	const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
	budget.signal?.throwIfAborted()
	await writeFile(temp, seal.pack(page), { flag: 'wx', mode: 0o600 })
	await rename(temp, path)
	return { page, cacheHit: false }
}
