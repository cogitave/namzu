import { lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { digest, mayContain } from './format.js'
import {
	type EvidenceSeal,
	entrySchema,
	evidenceSeal,
	indexPage,
	positionSchema,
} from './index-page.js'
import {
	type EvidenceBudget,
	EvidencePageLimit,
	PAGE_BYTES,
	decode,
	openEvidence,
	readSmall,
	stamp,
} from './io.js'
import { readTextPage, sourceText } from './source-text.js'
import type {
	DiskRunEvidenceOptions,
	RunEvidenceReadOptions,
	RunEvidenceReadResult,
	RunEvidenceSource,
	RunTextEvidenceMatch,
	RunTextEvidenceReadResult,
	RunTextEvidenceSearchOptions,
	RunTextEvidenceSource,
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
	seq: integer.optional(),
	part: integer.optional(),
	mode: z.enum(['tools', 'text']).default('tools'),
	position: positionSchema,
	entry: integer.max(64),
	chunk: integer,
})
const pointerSchema = entrySchema.pick({
	offset: true,
	length: true,
	sha256: true,
	seq: true,
	part: true,
})
const addressSchema = z.object({ kind: z.literal('text'), entry: pointerSchema })
/**
 * @experimental Bounded, authenticated disk index over one explicitly authorized closed run.
 * The host owns authorization and the private directories. Stat changes invalidate addresses;
 * individual record/chunk digests detect changed bytes. This is not a hostile filesystem sandbox.
 */
export function createDiskRunTextEvidenceSource(
	options: DiskRunEvidenceOptions,
): RunTextEvidenceSource {
	return createSource(options, 'text')
}

/** @experimental Tool-only view of the shared invocation text index. */
export function createDiskRunEvidenceSource(options: DiskRunEvidenceOptions): RunEvidenceSource {
	const source = createSource(options, 'tools')
	const tool = <T extends { toolName?: string; isError?: boolean }>(value: T) => {
		if (value.toolName === undefined || value.isError === undefined)
			throw new Error('Expected tool evidence.')
		return { ...value, toolName: value.toolName, isError: value.isError }
	}
	return Object.freeze({
		scope: source.scope,
		async search(options: RunTextEvidenceSearchOptions = {}, signal?: AbortSignal) {
			const result = await source.search(options, signal)
			return { ...result, matches: result.matches.map(tool) }
		},
		async read(
			options: RunEvidenceReadOptions,
			signal?: AbortSignal,
		): Promise<RunEvidenceReadResult> {
			return tool(await source.read(options, signal))
		},
	})
}

function createSource(
	options: DiskRunEvidenceOptions,
	mode: 'tools' | 'text',
): RunTextEvidenceSource {
	const maxReadBytes = z
		.number()
		.int()
		.min(1024 * 1024)
		.max(PAGE_BYTES)
		.parse(options.maxReadBytes ?? PAGE_BYTES)
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
		const budget: EvidenceBudget = { bytes: 0, limit: maxReadBytes, signal }
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
			const sourceKey = digest(
				`${mode === 'text' ? 'text-v2:' : ''}${scopeKey}:${stamp(before)}:${digest(metaBytes)}`,
			)
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
		async search(options: RunTextEvidenceSearchOptions = {}, signal?: AbortSignal) {
			const input = z
				.object({
					query: z.string().max(256).optional(),
					cursor: z.string().max(4096).optional(),
					seq: integer.positive().optional(),
					part: integer.optional(),
					limit: integer.min(1).max(4).default(4),
				})
				.strict()
				.parse(options)
			if (input.part !== undefined && input.seq === undefined)
				throw new Error('Part requires an event sequence.')
			const query = input.query ?? ''
			return access(signal, async (handle, size, seal, sourceKey, budget) => {
				const cursor = input.cursor
					? cursorSchema.parse(seal.unpack(input.cursor))
					: {
							kind: 'search' as const,
							query,
							seq: input.seq,
							part: input.part,
							mode,
							position: { offset: 0, seq: 0, textIndex: 0 },
							entry: 0,
							chunk: 0,
						}
				if (
					cursor.query !== query ||
					cursor.seq !== input.seq ||
					cursor.part !== input.part ||
					cursor.mode !== mode
				)
					throw new Error('Search cursor query changed.')
				const { page, cacheHit } = await indexPage(
					handle,
					size,
					scope.runId,
					cursor.position,
					seal,
					sourceKey,
					budget,
				)
				const matches: RunTextEvidenceMatch[] = []
				const unavailable: string[] = []
				let partial = false
				let entryIndex = cursor.entry
				let chunk = cursor.chunk
				while (entryIndex < page.entries.length && matches.length < input.limit) {
					const entry = page.entries[entryIndex]
					if (!entry) throw new Error('Invalid index entry.')
					if (
						(mode === 'tools' && entry.source !== 'tool_completed') ||
						(input.seq !== undefined && entry.seq !== input.seq) ||
						(input.part !== undefined && entry.part !== input.part)
					) {
						entryIndex++
						chunk = 0
						continue
					}
					try {
						if (entry.truncated && !entry.spill) partial = true
						if (!entry.spill && !mayContain(entry.filter, query)) {
							entryIndex++
							chunk = 0
							continue
						}
						const source = await sourceText(handle, entry, runDir, scope.runId, budget)
						while (chunk < source.chunks && matches.length < input.limit) {
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
										source: entry.source,
										part: entry.part,
										characterOffset:
											window.characterOffset === undefined
												? undefined
												: window.characterOffset + start,
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
						unavailable.push(`Text record ${entry.seq}/${entry.part} is unavailable or changed.`)
					}
					entryIndex++
					chunk = 0
				}
				const nextCursor =
					entryIndex < page.entries.length
						? seal.pack({ ...cursor, entry: entryIndex, chunk })
						: page.next && (input.seq === undefined || page.next.seq < input.seq)
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
		): Promise<RunTextEvidenceReadResult> {
			const input = z
				.object({ address: z.string().max(8192), byteOffset: integer.optional() })
				.strict()
				.parse(options)
			return access(signal, async (handle, _size, seal, _sourceKey, budget) => {
				const pointer = addressSchema.parse(seal.unpack(input.address)).entry
				const source = await sourceText(handle, pointer, runDir, scope.runId, budget)
				const entry = source.entry
				if (mode === 'tools' && entry.source !== 'tool_completed')
					throw new Error('Not tool evidence.')
				return readTextPage(source, scope, input.byteOffset ?? 0, budget)
			})
		},
	})
}
