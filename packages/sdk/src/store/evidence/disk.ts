import type { FileHandle } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
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
	stamp,
} from './io.js'
import { passageMatcher, passagesInWindow } from './passages.js'
import { evidenceSearchInput, evidenceTermRefinement, evidenceTermsSchema } from './search-input.js'
import {
	evidenceExclusionsKey,
	evidenceExclusionsSchema,
	excludesSuccessfulTool,
} from './selection.js'
import { createTextSourceReader, readTextPage } from './source-text.js'
import type {
	SessionEvidenceReadOptions,
	SessionEvidenceReadResult,
	SessionEvidenceSource,
	SessionEvidenceSourceOptions,
	SessionTextEvidenceMatch,
	SessionTextEvidenceReadResult,
	SessionTextEvidenceSearchOptions,
	SessionTextEvidenceSource,
} from './types.js'

const integer = z.number().int().nonnegative().safe()
const scopeSchema = z
	.object({
		tenantId: z.string().uuid(),
		projectId: z.string().uuid(),
		sessionId: z.string().uuid(),
		turnId: z.string().uuid().optional(),
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

/** Ignore an uncommitted tail in a snapshot without repairing the writer's file. */
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
	if (floor === 0) throw new Error('The session log has no complete recorded evidence.')
	throw new Error('Incomplete session log tail exceeds the bounded record size.')
}

/**
 * A fixed end of the log a source reads up to: a record the capturing writer
 * vouches for. Appends after it do not change what the source sees.
 */
export interface EvidenceAnchor {
	readonly seq: number
	readonly offset: number
	readonly length: number
	readonly sha256: string
}

/**
 * @experimental Bounded, authenticated evidence over one explicitly authorized
 * session log, or one turn of it. Closed by default (no active turn in scope);
 * snapshot mode also reads a session whose turn is running, without assuming
 * its writer is dead. The host owns authorization and the log's directory.
 * Changes to the log invalidate addresses; record and chunk digests detect
 * changed bytes. This is not a hostile filesystem sandbox.
 */
export function createSessionTextEvidenceSource(
	options: SessionEvidenceSourceOptions,
): SessionTextEvidenceSource {
	return createSource(options, 'text')
}

/**
 * @internal A text source anchored at a record the writer holds: appends
 * after it neither invalidate its addresses nor become visible to it.
 */
export function createAnchoredSessionTextEvidenceSource(
	options: SessionEvidenceSourceOptions,
	anchor: EvidenceAnchor,
): SessionTextEvidenceSource {
	return createSource(options, 'text', anchor)
}

/** @experimental Tool-only view of the shared session text index. */
export function createSessionEvidenceSource(
	options: SessionEvidenceSourceOptions,
): SessionEvidenceSource {
	const source = createSource(options, 'tools')
	const tool = <T extends { toolName?: string; isError?: boolean }>(value: T) => {
		if (value.toolName === undefined || value.isError === undefined)
			throw new Error('Expected tool evidence.')
		return { ...value, toolName: value.toolName, isError: value.isError }
	}
	return Object.freeze({
		scope: source.scope,
		supportsTermRefinement: true,
		async search(options: SessionTextEvidenceSearchOptions = {}, signal?: AbortSignal) {
			const result = await source.search(options, signal)
			return { ...result, matches: result.matches.map(tool) }
		},
		async read(
			options: SessionEvidenceReadOptions,
			signal?: AbortSignal,
		): Promise<SessionEvidenceReadResult> {
			return tool(await source.read(options, signal))
		},
	})
}

/**
 * The first record of a session log (its `session_started`) and whether the
 * scope is closed: no turn of the session active, or — for a scope narrowed
 * to one turn — that turn settled.
 */
async function sessionState(
	handle: FileHandle,
	size: number,
	scope: z.infer<typeof scopeSchema>,
): Promise<{ first: Buffer; closed: boolean }> {
	const unmetered: EvidenceBudget = { bytes: 0, limit: Number.MAX_SAFE_INTEGER }
	let first: Buffer | undefined
	let active: string | undefined
	let turnClosed = false
	let buffered = Buffer.alloc(0)
	let offset = 0
	while (offset < size || buffered.length > 0) {
		let newline = buffered.indexOf(10)
		if (newline < 0) {
			if (offset >= size) break
			if (buffered.length >= RECORD_BYTES) throw new Error('Session log record exceeds 4 MiB.')
			const count = Math.min(1 << 20, size - offset)
			buffered = Buffer.concat([buffered, await readBytes(handle, offset, count, unmetered)])
			offset += count
			continue
		}
		const raw = buffered.subarray(0, newline + 1)
		buffered = buffered.subarray(newline + 1)
		newline = -1
		const record = JSON.parse(decode(raw)) as Record<string, unknown>
		if (!first) {
			if (
				record.type !== 'session_started' ||
				record.sessionId !== scope.sessionId ||
				record.projectId !== scope.projectId ||
				(record.tenantId !== undefined && record.tenantId !== scope.tenantId)
			) {
				throw new Error('The session log does not belong to the authorized scope.')
			}
			first = Buffer.from(raw)
			continue
		}
		if (record.type === 'turn_started') active = record.turnId as string
		if (record.type === 'turn_completed' || record.type === 'turn_failed') {
			if (active === record.turnId) active = undefined
			if (record.turnId === scope.turnId) turnClosed = true
		}
	}
	if (!first) throw new Error('The session log is empty; evidence is incomplete.')
	return { first, closed: scope.turnId !== undefined ? turnClosed : active === undefined }
}

function createSource(
	options: SessionEvidenceSourceOptions,
	mode: 'tools' | 'text',
	anchor?: EvidenceAnchor,
): SessionTextEvidenceSource {
	const consistency = z.enum(['closed', 'snapshot']).parse(options.consistency ?? 'closed')
	const maxReadBytes = z
		.number()
		.int()
		.min(1024 * 1024)
		.max(PAGE_BYTES)
		.parse(options.maxReadBytes ?? PAGE_BYTES)
	const scope = Object.freeze(scopeSchema.parse(options.scope))
	const logPath = resolve(options.logPath)
	if (!logPath.endsWith('.jsonl')) throw new Error('A session log path ends in .jsonl.')
	const sessionDir = logPath.slice(0, -'.jsonl'.length)
	const scopeKey = digest(JSON.stringify(scope))
	async function access<T>(
		signal: AbortSignal | undefined,
		requestedBytes: number | undefined,
		action: (
			handle: FileHandle,
			size: number,
			seal: EvidenceSeal,
			sourceKey: string,
			budget: EvidenceBudget,
			nonterminal: boolean,
		) => Promise<T>,
	): Promise<T> {
		const budget: EvidenceBudget = {
			bytes: 0,
			limit: Math.min(maxReadBytes, requestedBytes ?? maxReadBytes),
			signal,
		}
		signal?.throwIfAborted()
		const handle = await openEvidence(logPath)
		try {
			const before = await handle.stat()
			if (before.size === 0) throw new Error('The session log is empty; evidence is incomplete.')
			let size: number
			if (anchor) {
				size = anchor.offset + anchor.length
				if (size > before.size) throw new Error('The session log is shorter than its anchor.')
			} else {
				size =
					consistency === 'snapshot'
						? await completePrefix(handle, before.size, budget)
						: before.size
			}
			const state = await sessionState(handle, size, scope)
			if (!state.closed && consistency === 'closed') {
				throw new Error('Evidence scope has an active turn; it is not closed.')
			}
			const anchorKey = anchor ? await verifyAnchor(handle, anchor) : undefined
			const sourceKey = digest(
				`session-v1:${consistency}:${mode}:${scopeKey}:${anchorKey ?? stamp(before)}`,
			)
			const seal = evidenceSeal(state.first, sourceKey)
			const value = await action(handle, size, seal, sourceKey, budget, !state.closed)
			signal?.throwIfAborted()
			if (anchor) {
				if ((await verifyAnchor(handle, anchor)) !== anchorKey)
					throw new Error('Evidence source changed during retrieval.')
			} else if (
				stamp(before) !== stamp(await handle.stat()) ||
				stamp(before) !== stamp(await lstat(logPath))
			) {
				throw new Error('Evidence source changed during retrieval.')
			}
			return value
		} finally {
			await handle.close()
		}
	}
	return Object.freeze({
		scope,
		supportsTermRefinement: true,
		async search(options: SessionTextEvidenceSearchOptions = {}, signal?: AbortSignal) {
			const input = z
				.object({
					maxReadBytes: integer
						.min(1024 * 1024)
						.max(PAGE_BYTES)
						.optional(),
					query: z.string().max(256).optional(),
					terms: evidenceTermsSchema,
					refineTerms: evidenceTermsSchema,
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
			const refined = input.refineTerms
				? evidenceSearchInput({
						terms: evidenceTermRefinement(input, input.refineTerms),
						matchMode: 'token',
					})
				: undefined
			const selectedTerms = refined?.terms ?? terms
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
			return access(
				signal,
				input.maxReadBytes,
				async (handle, size, seal, _sourceKey, budget, nonterminal) => {
					const readSource = createTextSourceReader(handle, sessionDir, scope.sessionId, budget)
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
					// Authenticate the original query first, then seal future cursors
					// with the narrower key at exactly the same archive position.
					if (refined) cursor.termsKey = refined.termsKey
					const { page, cacheHit } = await indexPage(
						handle,
						size,
						scope.sessionId,
						cursor.position,
						budget,
					)
					const matches: SessionTextEvidenceMatch[] = []
					const unavailable: string[] = []
					let partial = false
					let excludedToolResults = 0
					let excludedSummaries = 0
					let entryIndex = cursor.entry
					let chunk = cursor.chunk
					let within = cursor.within
					const matchPassage = passageMatcher(
						selectedTerms ?? query,
						input.caseSensitive,
						input.matchMode,
					)
					while (entryIndex < page.entries.length && matches.length < input.limit) {
						const entry = page.entries[entryIndex]
						if (!entry) throw new Error('Invalid index entry.')
						if (
							(mode === 'tools' && entry.source !== 'tool_completed') ||
							(scope.turnId !== undefined && entry.turnId !== scope.turnId) ||
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
								!(selectedTerms ?? [query]).some((term) =>
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
									(selectedTerms ?? [query]).some((term) =>
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
										const excerpt = text.slice(start, end)
										const byteOffset = window.offset + Buffer.byteLength(text.slice(0, start))
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
											excerpt,
											excerptComplete:
												source.retained === 'full' &&
												byteOffset === 0 &&
												Buffer.byteLength(excerpt) === source.bytes,
											byteOffset,
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
				},
			)
		},
		async read(
			options: SessionEvidenceReadOptions,
			signal?: AbortSignal,
		): Promise<SessionTextEvidenceReadResult> {
			const input = z
				.object({
					address: z.string().max(8192),
					byteOffset: integer.optional(),
					maxReadBytes: integer
						.min(1024 * 1024)
						.max(PAGE_BYTES)
						.optional(),
				})
				.strict()
				.parse(options)
			return access(signal, input.maxReadBytes, async (handle, _size, seal, _sourceKey, budget) => {
				const pointer = addressSchema.parse(seal.unpack(input.address)).entry
				const source = await createTextSourceReader(
					handle,
					sessionDir,
					scope.sessionId,
					budget,
				)(pointer)
				const entry = source.entry
				if (mode === 'tools' && entry.source !== 'tool_completed')
					throw new Error('Not tool evidence.')
				if (scope.turnId !== undefined && entry.turnId !== scope.turnId)
					throw new Error('Evidence is outside the authorized turn.')
				return readTextPage(source, scope, input.byteOffset ?? 0, budget)
			})
		},
	})
}

/** The anchor record must still hold the bytes the writer vouched for. */
async function verifyAnchor(handle: FileHandle, anchor: EvidenceAnchor): Promise<string> {
	const bytes = await readBytes(handle, anchor.offset, anchor.length, {
		bytes: 0,
		limit: Number.MAX_SAFE_INTEGER,
	})
	if (digest(bytes) !== anchor.sha256) throw new Error('The session log changed below its anchor.')
	const record = JSON.parse(decode(bytes)) as { seq?: unknown }
	if (record.seq !== anchor.seq) throw new Error('The session log changed below its anchor.')
	return `${anchor.seq}:${anchor.sha256}`
}
