import { lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { EVIDENCE_CHUNK_BYTES, SEARCH_OVERLAP_BYTES, digest, mayContain } from './format.js'
import {
	type EvidenceSeal,
	type IndexEntry,
	entrySchema,
	evidenceSeal,
	indexPage,
	positionSchema,
} from './index-page.js'
import {
	type EvidenceBudget,
	EvidencePageLimit,
	decode,
	openEvidence,
	readBytes,
	readSmall,
	stamp,
	utf8Page,
} from './io.js'
import type {
	DiskRunEvidenceOptions,
	RunEvidenceMatch,
	RunEvidenceReadOptions,
	RunEvidenceReadResult,
	RunEvidenceSource,
} from './types.js'

const integer = z.number().int().nonnegative().safe()
const scopeSchema = z
	.object({
		tenantId: z.string().uuid(),
		projectId: z.string().uuid(),
		sessionId: z.string().uuid(),
		runId: z.string().uuid(),
	})
	.strict()
const cursorSchema = z.object({
	kind: z.literal('search'),
	query: z.string().max(256),
	position: positionSchema,
	entry: integer.max(64),
	chunk: integer,
})
const pointerSchema = entrySchema.pick({ offset: true, length: true, sha256: true, seq: true })
const addressSchema = z.object({ kind: z.literal('text'), entry: pointerSchema })
const manifestSchema = z.object({
	version: z.literal(1),
	bytes: integer,
	chunkBytes: z.literal(EVIDENCE_CHUNK_BYTES),
	chunks: z
		.array(z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), filter: z.string().max(1400) }))
		.max(4096),
})

interface TextSource {
	entry: IndexEntry
	bytes: number
	retained: 'full' | 'preview'
	chunks: number
	mayMatch(chunk: number, query: string): boolean
	window(chunk: number): Promise<{ bytes: Buffer; offset: number }>
}

async function sourceText(
	handle: FileHandle,
	pointer: z.infer<typeof pointerSchema>,
	runDir: string,
	runId: string,
	budget: EvidenceBudget,
): Promise<TextSource> {
	const raw = await readBytes(handle, pointer.offset, pointer.length, budget)
	if (digest(raw) !== pointer.sha256) throw new Error('Recorded tool evidence changed.')
	const event = JSON.parse(decode(raw))
	if (
		event.type !== 'tool_completed' ||
		event.runId !== runId ||
		event.seq !== pointer.seq ||
		typeof event.result !== 'string'
	)
		throw new Error('Recorded tool identity changed.')
	const entry = entrySchema.parse({
		...pointer,
		toolName: event.toolName,
		toolUseId: event.toolUseId,
		isError: event.isError,
		truncated: event.outputTruncated === true,
		spill: event.outputSpillIntegrity,
		filter: '',
	})

	if (!entry.spill) {
		const bytes = Buffer.from(event.result, 'utf8')
		return {
			entry,
			bytes: bytes.length,
			retained: entry.truncated ? 'preview' : 'full',
			chunks: 1,
			mayMatch: () => true,
			window: async () => ({ bytes, offset: 0 }),
		}
	}
	// Never follow a model/provider-controlled spill path from the event.
	const path = join(runDir, 'tool-output', `${digest(entry.toolUseId)}.txt`)
	const rawManifest = await readSmall(`${path}.manifest.json`, budget)
	if (digest(rawManifest) !== entry.spill) throw new Error('Retained output manifest changed.')
	const manifest = manifestSchema.parse(JSON.parse(decode(rawManifest)))
	if (manifest.chunks.length !== Math.ceil(manifest.bytes / EVIDENCE_CHUNK_BYTES))
		throw new Error('Incomplete retained output manifest.')
	return {
		entry,
		bytes: manifest.bytes,
		retained: 'full',
		chunks: Math.max(1, manifest.chunks.length),
		mayMatch: (chunk, query) =>
			manifest.chunks[chunk] ? mayContain(manifest.chunks[chunk].filter, query) : query === '',
		async window(chunk) {
			const file = await openEvidence(path)
			try {
				const before = await file.stat()
				if (before.size !== manifest.bytes) throw new Error('Retained output size changed.')
				const pieces: Buffer[] = []
				for (let index = chunk; index < Math.min(chunk + 2, manifest.chunks.length); index++) {
					const bytes = await readBytes(
						file,
						index * EVIDENCE_CHUNK_BYTES,
						Math.min(EVIDENCE_CHUNK_BYTES, manifest.bytes - index * EVIDENCE_CHUNK_BYTES),
						budget,
					)
					if (digest(bytes) !== manifest.chunks[index]?.sha256)
						throw new Error('Retained output bytes changed.')
					pieces.push(bytes)
				}
				if (
					stamp(before) !== stamp(await file.stat()) ||
					stamp(before) !== stamp(await lstat(path))
				)
					throw new Error('Retained output changed during read.')
				const all = Buffer.concat(pieces)
				let start = 0
				while (start < all.length && ((all[start] ?? 0) & 0xc0) === 0x80) start++
				return {
					bytes: utf8Page(all.subarray(start), EVIDENCE_CHUNK_BYTES + SEARCH_OVERLAP_BYTES - start),
					offset: chunk * EVIDENCE_CHUNK_BYTES + start,
				}
			} finally {
				await file.close()
			}
		},
	}
}

/**
 * @experimental Bounded, authenticated disk index over one explicitly authorized closed run.
 * The host owns authorization and the private directories. Stat changes invalidate addresses;
 * individual record/chunk digests detect changed bytes. This is not a hostile filesystem sandbox.
 */
export function createDiskRunEvidenceSource(options: DiskRunEvidenceOptions): RunEvidenceSource {
	const scope = Object.freeze(scopeSchema.parse(options.scope))
	const runDir = resolve(options.runDir)
	const indexDir = resolve(options.indexDir)
	const scopeKey = digest(JSON.stringify(scope))
	async function access<T>(
		signal: AbortSignal | undefined,
		action: (
			handle: FileHandle,
			size: number,
			seal: EvidenceSeal,
			sourceKey: string,
			budget: EvidenceBudget,
		) => Promise<T>,
	): Promise<T> {
		const budget: EvidenceBudget = { bytes: 0, signal }
		signal?.throwIfAborted()
		const metaPath = join(runDir, 'run.json')
		const metaStamp = stamp(await lstat(metaPath))
		const metaBytes = await readSmall(metaPath, budget, 512 * 1024)
		if (metaStamp !== stamp(await lstat(metaPath)))
			throw new Error('Run metadata changed during retrieval.')
		const meta = JSON.parse(decode(metaBytes))
		if (
			meta.id !== scope.runId ||
			!['completed', 'failed', 'cancelled'].includes(meta.status) ||
			JSON.stringify(scopeSchema.parse(meta.metadata?.scope)) !== JSON.stringify(scope)
		)
			throw new Error('Evidence run is not closed or does not belong to the authorized scope.')
		const path = join(runDir, 'transcript.jsonl')
		const handle = await openEvidence(path)
		try {
			const before = await handle.stat()
			if (before.size === 0) throw new Error('Transcript is empty; evidence is incomplete.')
			const sourceKey = digest(`${scopeKey}:${stamp(before)}:${digest(metaBytes)}`)
			const seal = await evidenceSeal(indexDir, scopeKey, sourceKey, budget)
			const value = await action(handle, before.size, seal, sourceKey, budget)
			signal?.throwIfAborted()
			if (
				stamp(before) !== stamp(await handle.stat()) ||
				stamp(before) !== stamp(await lstat(path)) ||
				metaStamp !== stamp(await lstat(metaPath))
			)
				throw new Error('Evidence source changed during retrieval.')
			return value
		} finally {
			await handle.close()
		}
	}
	return Object.freeze({
		scope,
		async search(options = {}, signal?: AbortSignal) {
			const input = z
				.object({ query: z.string().max(256).optional(), cursor: z.string().max(4096).optional() })
				.strict()
				.parse(options)
			const query = input.query ?? ''
			return access(signal, async (handle, size, seal, sourceKey, budget) => {
				const cursor = input.cursor
					? cursorSchema.parse(seal.unpack(input.cursor))
					: { kind: 'search' as const, query, position: { offset: 0, seq: 0 }, entry: 0, chunk: 0 }
				if (cursor.query !== query) throw new Error('Search cursor query changed.')
				const { page, cacheHit } = await indexPage(
					handle,
					size,
					scope.runId,
					cursor.position,
					seal,
					sourceKey,
					budget,
				)
				const matches: RunEvidenceMatch[] = []
				const unavailable: string[] = []
				let partial = false
				let entryIndex = cursor.entry
				let chunk = cursor.chunk
				while (entryIndex < page.entries.length && matches.length < 4) {
					const entry = page.entries[entryIndex]
					if (!entry) throw new Error('Invalid index entry.')
					try {
						if (entry.truncated && !entry.spill) partial = true
						if (!entry.spill && !mayContain(entry.filter, query)) {
							entryIndex++
							chunk = 0
							continue
						}
						const source = await sourceText(handle, entry, runDir, scope.runId, budget)
						while (chunk < source.chunks && matches.length < 4) {
							signal?.throwIfAborted()
							if (source.mayMatch(chunk, query)) {
								const window = await source.window(chunk)
								const text = decode(window.bytes)
								const hit = text.indexOf(query)
								if (hit >= 0) {
									let start = Math.max(0, hit - 120)
									if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start--
									let end = Math.min(text.length, start + 512)
									if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
									matches.push({
										address: seal.pack({ kind: 'text', entry: pointerSchema.parse(entry) }),
										seq: entry.seq,
										toolName: entry.toolName,
										isError: entry.isError,
										retained: source.retained,
										excerpt: text.slice(start, end),
										byteOffset: window.offset + Buffer.byteLength(text.slice(0, start)),
									})
								}
							}
							chunk++
							if (!query) {
								chunk = source.chunks
								break
							}
						}
						if (chunk < source.chunks) break
					} catch (error) {
						signal?.throwIfAborted()
						if (error instanceof EvidencePageLimit) break
						unavailable.push(`Tool record ${entry.seq} is unavailable or changed.`)
					}
					entryIndex++
					chunk = 0
				}
				const nextCursor =
					entryIndex < page.entries.length
						? seal.pack({ ...cursor, entry: entryIndex, chunk })
						: page.next
							? seal.pack({ ...cursor, position: page.next, entry: 0, chunk: 0 })
							: null
				return {
					scope,
					matches,
					nextCursor,
					scannedBytes: budget.bytes,
					indexedRecords: cacheHit ? 0 : page.records,
					cacheHit,
					incomplete: unavailable.length > 0 || partial,
					unavailable,
				}
			})
		},
		async read(
			options: RunEvidenceReadOptions,
			signal?: AbortSignal,
		): Promise<RunEvidenceReadResult> {
			const input = z
				.object({ address: z.string().max(8192), byteOffset: integer.optional() })
				.strict()
				.parse(options)
			return access(signal, async (handle, _size, seal, _sourceKey, budget) => {
				const pointer = addressSchema.parse(seal.unpack(input.address)).entry
				const source = await sourceText(handle, pointer, runDir, scope.runId, budget)
				const entry = source.entry
				const offset = input.byteOffset ?? 0
				if (offset > source.bytes) throw new Error('Offset exceeds retained text.')
				const chunk = entry.spill
					? Math.min(Math.floor(offset / EVIDENCE_CHUNK_BYTES), source.chunks - 1)
					: 0
				const window = await source.window(chunk)
				if (offset < window.offset) throw new Error('Offset splits a UTF-8 character.')
				const bytes = window.bytes.subarray(offset - window.offset)
				let text = decode(utf8Page(bytes, 24_000))
				if (text.length > 6000) {
					let end = 6000
					if (/[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
					text = text.slice(0, end)
				}
				const next = offset + Buffer.byteLength(text)
				if (next === offset && offset < source.bytes) throw new Error('Text page did not advance.')
				return {
					scope,
					seq: entry.seq,
					toolName: entry.toolName,
					isError: entry.isError,
					retained: source.retained,
					text,
					byteOffset: offset,
					nextByteOffset: next < source.bytes ? next : null,
					totalBytes: source.bytes,
					scannedBytes: budget.bytes,
				}
			})
		},
	})
}
