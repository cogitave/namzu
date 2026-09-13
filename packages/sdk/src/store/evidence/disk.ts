import { lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { EVIDENCE_CHUNK_BYTES, digest, mayContain, mayContainToken } from './format.js'
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
	RECORD_BYTES,
	decode,
	openEvidence,
	readBytes,
	readSmall,
	stamp,
} from './io.js'
import { passageMatcher, passagesInWindow } from './passages.js'
import { evidenceSearchInput, evidenceTermsSchema } from './search-input.js'
import {
	evidenceExclusionsKey,
	evidenceExclusionsSchema,
	excludesSuccessfulTool,
} from './selection.js'
import { createTextSourceReader, readTextPage } from './source-text.js'
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
	kind: z.enum(['search', 'search-terms', 'search-tokens']),
	query: z.string().max(256),
	termsKey: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	caseSensitive: z.boolean().default(true),
	matchMode: z.enum(['literal', 'token']).default('literal'),
	exclusionsKey: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	seq: integer.optional(),
	part: integer.optional(),
	mode: z.enum(['tools', 'text']).default('tools'),
	position: positionSchema,
	entry: integer.max(64),
	chunk: integer,
	within: integer.default(0),
})
const pointerSchema = entrySchema.pick({
	offset: true,
	length: true,
	sha256: true,
	seq: true,
	part: true,
})
const addressSchema = z.object({ kind: z.literal('text'), entry: pointerSchema })

/** Ignore an uncommitted tail in a nonterminal snapshot without repairing the writer's file. */
async function completePrefix(handle: FileHandle, size: number, budget: EvidenceBudget) {
	if ((await readBytes(handle, size - 1, 1, budget))[0] === 10) return size
	const floor = Math.max(0, size - RECORD_BYTES)
	let end = size - 1
	while (end > floor) {
		const start = Math.max(floor, end - 65_536)
		const bytes = await readBytes(handle, start, end - start, budget)
		const newline = bytes.lastIndexOf(10)
		if (newline >= 0) return start + newline + 1
		end = start
	}
	if (floor === 0) throw new Error('Transcript has no complete recorded evidence.')
	throw new Error('Incomplete transcript tail exceeds the bounded record size.')
}
/**
 * @experimental Bounded, authenticated disk index over one explicitly authorized run.
 * Closed by default; snapshot mode permits nonterminal metadata without assuming a dead writer.
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
	const consistency = z.enum(['closed', 'snapshot']).parse(options.consistency ?? 'closed')
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
			nonterminal: boolean,
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
		const terminal = ['completed', 'failed', 'cancelled'].includes(meta.status)
		const readable =
			terminal ||
			(consistency === 'snapshot' && ['idle', 'pending', 'running'].includes(meta.status))
		if (
			meta.id !== scope.runId ||
			!readable ||
			JSON.stringify(scopeSchema.parse(meta.metadata?.scope)) !== JSON.stringify(scope)
		)
			throw new Error(
				consistency === 'closed'
					? 'Evidence run is not closed or does not belong to the authorized scope.'
					: 'Evidence run does not satisfy snapshot consistency or its authorized scope.',
			)
		const path = join(runDir, 'transcript.jsonl')
		const handle = await openEvidence(path)
		try {
			const before = await handle.stat()
			if (before.size === 0) throw new Error('Transcript is empty; evidence is incomplete.')
			const size =
				consistency === 'snapshot' && !terminal
					? await completePrefix(handle, before.size, budget)
					: before.size
			const sourceKey = digest(
				`${consistency === 'snapshot' ? 'snapshot-v1:' : ''}${mode === 'text' ? 'text-v2:' : ''}${scopeKey}:${stamp(before)}:${digest(metaBytes)}`,
			)
			const seal = await evidenceSeal(indexDir, scopeKey, sourceKey, budget)
			const value = await action(handle, size, seal, sourceKey, budget, !terminal)
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
					terms: evidenceTermsSchema,
					caseSensitive: z.boolean().default(true),
					matchMode: z.enum(['literal', 'token']).default('literal'),
					excludeSuccessfulTools: evidenceExclusionsSchema,
					excludeDerivedSummaries: z.boolean().default(false),
					cursor: z.string().max(4096).optional(),
					seq: integer.positive().optional(),
					part: integer.optional(),
					limit: integer.min(1).max(4).default(4),
				})
				.strict()
				.parse(options)
			if (input.part !== undefined && input.seq === undefined)
				throw new Error('Part requires an event sequence.')
			const { query, terms, termsKey, browse } = evidenceSearchInput(input)
			const exclusionsKey = evidenceExclusionsKey(
				input.excludeSuccessfulTools,
				input.excludeDerivedSummaries,
			)
			const kind =
				input.matchMode === 'token'
					? ('search-tokens' as const)
					: terms
						? ('search-terms' as const)
						: ('search' as const)
			return access(signal, async (handle, size, seal, sourceKey, budget, nonterminal) => {
				const readSource = createTextSourceReader(handle, runDir, scope.runId, budget)
				const cursor = input.cursor
					? cursorSchema.parse(seal.unpack(input.cursor))
					: {
							kind,
							query,
							termsKey,
							exclusionsKey,
							seq: input.seq,
							part: input.part,
							mode,
							position: { offset: 0, seq: 0, textIndex: 0 },
							entry: 0,
							chunk: 0,
							within: 0,
							caseSensitive: input.caseSensitive,
							matchMode: input.matchMode,
						}
				if (
					cursor.kind !== kind ||
					cursor.query !== query ||
					cursor.termsKey !== termsKey ||
					cursor.exclusionsKey !== exclusionsKey ||
					cursor.caseSensitive !== input.caseSensitive ||
					cursor.matchMode !== input.matchMode ||
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
				let excludedToolResults = 0
				let excludedSummaries = 0
				let entryIndex = cursor.entry
				let chunk = cursor.chunk
				let within = cursor.within
				const matchPassage = passageMatcher(terms ?? query, input.caseSensitive, input.matchMode)
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
						within = 0
						continue
					}
					try {
						const derived =
							input.excludeDerivedSummaries && entry.source === 'compaction_shed:summary'
						if (derived || excludesSuccessfulTool(entry, input.excludeSuccessfulTools)) {
							if (derived) excludedSummaries++
							else excludedToolResults++
							entryIndex++
							chunk = 0
							within = 0
							continue
						}
						if (entry.truncated && !entry.spill) partial = true
						if (
							!entry.spill &&
							!(terms ?? [query]).some((term) =>
								input.matchMode === 'token'
									? mayContainToken(entry.tokenFilter, term) &&
										(!input.caseSensitive || mayContain(entry.filter, term))
									: !input.caseSensitive || mayContain(entry.filter, term),
							)
						) {
							entryIndex++
							chunk = 0
							within = 0
							continue
						}
						const source = await readSource(entry)
						while (chunk < source.chunks && matches.length < input.limit) {
							signal?.throwIfAborted()
							if (
								(terms ?? [query]).some((term) =>
									source.mayMatch(chunk, term, input.matchMode, input.caseSensitive),
								)
							) {
								const window = await source.window(chunk, input.matchMode === 'token')
								const text = decode(window.bytes)
								const page = passagesInWindow(
									text,
									Math.max(within, window.searchFrom ?? 0),
									matchPassage,
									input.limit - matches.length,
									entry.spill ? (chunk + 1) * EVIDENCE_CHUNK_BYTES - window.offset : undefined,
								)
								within = page.next
								for (const { start, end } of page.passages) {
									matches.push({
										address: seal.pack({ kind: 'text', entry: pointerSchema.parse(entry) }),
										seq: entry.seq,
										recordedAt: source.recordedAt,
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
								if (within < text.length) break
							}
							within = 0
							chunk++
							if (browse) {
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
					within = 0
				}
				const nextCursor =
					entryIndex < page.entries.length
						? seal.pack({ ...cursor, entry: entryIndex, chunk, within })
						: page.next && (input.seq === undefined || page.next.seq < input.seq)
							? seal.pack({ ...cursor, position: page.next, entry: 0, chunk: 0, within: 0 })
							: null
				return {
					scope,
					matches,
					nextCursor,
					scannedBytes: budget.bytes,
					indexedRecords: cacheHit ? 0 : page.records,
					cacheHit,
					incomplete: nonterminal || unavailable.length > 0 || partial,
					unavailable,
					...(excludedToolResults ? { excludedToolResults } : {}),
					...(excludedSummaries ? { excludedSummaries } : {}),
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
				const source = await createTextSourceReader(handle, runDir, scope.runId, budget)(pointer)
				const entry = source.entry
				if (mode === 'tools' && entry.source !== 'tool_completed')
					throw new Error('Not tool evidence.')
				return readTextPage(source, scope, input.byteOffset ?? 0, budget)
			})
		},
	})
}
