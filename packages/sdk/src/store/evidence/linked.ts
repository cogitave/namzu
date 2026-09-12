import { lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { EVIDENCE_CHUNK_BYTES, digest } from './format.js'
import { type EvidenceSeal, eventTexts, evidenceSeal } from './index-page.js'
import {
	type EvidenceBudget,
	EvidencePageLimit,
	PAGE_BYTES,
	decode,
	openEvidence,
	readBytes,
	readSmall,
} from './io.js'
import { passageMatcher, passagesInWindow } from './passages.js'
import { type RecordPointer, recordPointerSchema } from './record-chain.js'
import { readTextPage, sourceText, textPointerSchema } from './source-text.js'
import type {
	DiskRunEvidenceOptions,
	RunEvidenceReadOptions,
	RunTextEvidenceMatch,
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
	kind: z.literal('linked-search'),
	query: z.string().max(256),
	caseSensitive: z.boolean().default(true),
	seq: integer.optional(),
	part: integer.optional(),
	next: recordPointerSchema.nullable(),
	textIndex: integer,
	chunk: integer,
	within: integer.default(0),
})
const addressSchema = z.object({ kind: z.literal('linked-text'), entry: textPointerSchema })

/** Internal: only the durable writer can supply this anchor. Never accept it from a tool input. */
export function createLinkedRunTextEvidenceSource(
	options: DiskRunEvidenceOptions,
	anchor: { tip: RecordPointer; identity: string; epoch: string },
): RunTextEvidenceSource {
	const scope = Object.freeze(scopeSchema.parse(options.scope))
	const runDir = options.runDir
	const tip = recordPointerSchema.parse(anchor.tip)
	const ceiling = tip.offset + tip.length
	const scopeKey = digest(JSON.stringify(scope))
	const sourceKey = digest(`linked-v1:${scopeKey}:${anchor.identity}:${anchor.epoch}`)
	const maxReadBytes = integer
		.min(1024 * 1024)
		.max(PAGE_BYTES)
		.parse(options.maxReadBytes ?? PAGE_BYTES)
	const inBoundary = (pointer: RecordPointer) => {
		if (pointer.seq > tip.seq || pointer.offset + pointer.length > ceiling)
			throw new Error('Evidence address exceeds the captured boundary.')
	}
	async function access<T extends { scannedBytes: number }>(
		signal: AbortSignal | undefined,
		action: (handle: FileHandle, seal: EvidenceSeal, budget: EvidenceBudget) => Promise<T>,
	): Promise<T> {
		const budget: EvidenceBudget = { bytes: 0, limit: maxReadBytes, signal }
		signal?.throwIfAborted()
		const verifyOwner = async () => {
			const metadata = JSON.parse(
				decode(await readSmall(join(runDir, 'run.json'), budget, 512 * 1024)),
			)
			if (
				metadata.id !== scope.runId ||
				JSON.stringify(scopeSchema.parse(metadata.metadata?.scope)) !== JSON.stringify(scope)
			)
				throw new Error('Evidence run does not belong to the authorized scope.')
		}
		await verifyOwner()
		// Reserve a final ownership check; counters/status may change while this run works.
		budget.limit = maxReadBytes - 512 * 1024

		const path = join(options.runDir, 'transcript.jsonl')
		const handle = await openEvidence(path)
		const check = (stat: { dev: number; ino: number; size: number }) => {
			if (`${stat.dev}:${stat.ino}` !== anchor.identity || stat.size < ceiling)
				throw new Error('Captured transcript was replaced or shortened.')
		}
		try {
			check(await handle.stat())
			const seal = await evidenceSeal(options.indexDir, scopeKey, sourceKey, budget)
			const result = await action(handle, seal, budget)
			signal?.throwIfAborted()
			check(await handle.stat())
			check(await lstat(path))
			budget.limit = maxReadBytes
			await verifyOwner()
			return { ...result, scannedBytes: budget.bytes }
		} finally {
			await handle.close()
		}
	}
	return Object.freeze({
		scope,
		async search(options: RunTextEvidenceSearchOptions = {}, signal?: AbortSignal) {
			const input = z
				.object({
					query: z.string().max(256).default(''),
					caseSensitive: z.boolean().default(true),
					cursor: z.string().max(4096).optional(),
					seq: integer.positive().optional(),
					part: integer.optional(),
					limit: integer.min(1).max(4).default(4),
				})
				.strict()
				.parse(options)
			if (input.part !== undefined && input.seq === undefined)
				throw new Error('Part requires an event sequence.')
			return access(signal, async (handle, seal, budget) => {
				const cursor = input.cursor
					? cursorSchema.parse(seal.unpack(input.cursor))
					: {
							kind: 'linked-search' as const,
							query: input.query,
							seq: input.seq,
							part: input.part,
							next: tip as RecordPointer | null,
							textIndex: 0,
							chunk: 0,
							within: 0,
							caseSensitive: input.caseSensitive,
						}
				if (
					cursor.query !== input.query ||
					cursor.caseSensitive !== input.caseSensitive ||
					cursor.seq !== input.seq ||
					cursor.part !== input.part
				)
					throw new Error('Search cursor query changed.')
				const matchPassage = passageMatcher(input.query, input.caseSensitive)
				const matches: RunTextEvidenceMatch[] = []
				const unavailable: string[] = []
				let records = 0
				let parts = 0
				let chunks = 0
				let incomplete = false
				while (
					cursor.next &&
					records < 64 &&
					parts < 64 &&
					chunks < 64 &&
					matches.length < input.limit
				) {
					const pointer = cursor.next
					inBoundary(pointer)
					if (input.seq !== undefined && pointer.seq < input.seq) {
						cursor.next = null
						break
					}
					let raw: Buffer
					try {
						raw = await readBytes(handle, pointer.offset, pointer.length, budget)
					} catch (error) {
						if (error instanceof EvidencePageLimit) {
							if (records === 0) throw new Error('Recorded text exceeds the available page budget.')
							break
						}
						throw error
					}
					if (digest(raw) !== pointer.sha256)
						throw new Error('Recorded text integrity chain changed.')
					const event = JSON.parse(decode(raw))
					if (event.runId !== scope.runId || event.seq !== pointer.seq)
						throw new Error('Recorded text identity changed.')
					records++
					let previous: RecordPointer | null = null
					if (event.previousRecord != null) {
						previous = recordPointerSchema.parse(event.previousRecord)
						if (
							previous.offset + previous.length !== pointer.offset ||
							previous.seq + 1 !== pointer.seq
						)
							throw new Error('Invalid text integrity chain.')
					} else if (pointer.seq === 1) {
						if (pointer.offset !== 0 || event.type !== 'run_started')
							throw new Error('Invalid transcript start.')
					} else {
						incomplete = true
					}
					const texts =
						input.seq === undefined || input.seq === pointer.seq ? eventTexts(event) : []
					while (
						cursor.textIndex < texts.length &&
						parts < 64 &&
						chunks < 64 &&
						matches.length < input.limit
					) {
						const part = cursor.textIndex
						if (input.part !== undefined && part !== input.part) {
							cursor.textIndex++
							continue
						}
						parts++
						try {
							const source = await sourceText(
								handle,
								{ ...pointer, part },
								runDir,
								scope.runId,
								budget,
								raw,
							)
							if (source.retained === 'preview') incomplete = true
							while (cursor.chunk < source.chunks && chunks < 64 && matches.length < input.limit) {
								signal?.throwIfAborted()
								chunks++
								if (!input.caseSensitive || source.mayMatch(cursor.chunk, input.query)) {
									const window = await source.window(cursor.chunk)
									const text = decode(window.bytes)
									const page = passagesInWindow(
										text,
										cursor.within,
										matchPassage,
										input.limit - matches.length,
										source.entry.spill
											? (cursor.chunk + 1) * EVIDENCE_CHUNK_BYTES - window.offset
											: undefined,
									)
									cursor.within = page.next
									for (const { start, end } of page.passages) {
										matches.push({
											address: seal.pack({ kind: 'linked-text', entry: { ...pointer, part } }),
											seq: pointer.seq,
											source: source.entry.source,
											part,
											toolName: source.entry.toolName,
											isError: source.entry.isError,
											retained: source.retained,
											excerpt: text.slice(start, end),
											byteOffset: window.offset + Buffer.byteLength(text.slice(0, start)),
											characterOffset:
												window.characterOffset === undefined
													? undefined
													: window.characterOffset + start,
										})
									}
									if (cursor.within < text.length) break
								}
								cursor.within = 0
								cursor.chunk++
								if (!input.query) cursor.chunk = source.chunks
							}
							if (cursor.chunk < source.chunks) break
						} catch (error) {
							signal?.throwIfAborted()
							if (error instanceof EvidencePageLimit && (records > 1 || parts > 1 || chunks > 1))
								break
							unavailable.push(`Text record ${pointer.seq}/${part} is unavailable or changed.`)
						}
						cursor.textIndex++
						cursor.chunk = 0
						cursor.within = 0
					}
					if (cursor.textIndex < texts.length) break
					cursor.next = previous
					cursor.textIndex = 0
					cursor.chunk = 0
					cursor.within = 0
				}
				return {
					scope,
					matches,
					nextCursor: cursor.next ? seal.pack(cursor) : null,
					scannedBytes: budget.bytes,
					indexedRecords: records,
					cacheHit: false,
					incomplete: incomplete || unavailable.length > 0,
					unavailable,
				}
			})
		},
		async read(options: RunEvidenceReadOptions, signal?: AbortSignal) {
			const input = z
				.object({ address: z.string().max(8192), byteOffset: integer.default(0) })
				.strict()
				.parse(options)
			return access(signal, async (handle, seal, budget) => {
				const pointer = addressSchema.parse(seal.unpack(input.address)).entry
				inBoundary(pointer)
				const source = await sourceText(handle, pointer, runDir, scope.runId, budget)
				return readTextPage(source, scope, input.byteOffset, budget)
			})
		},
	})
}
