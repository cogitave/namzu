import { lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { EVIDENCE_CHUNK_BYTES, SEARCH_OVERLAP_BYTES, digest, mayContain } from './format.js'
import { type IndexEntry, entrySchema, eventTexts } from './index-page.js'
import {
	type EvidenceBudget,
	decode,
	openEvidence,
	readBytes,
	readSmall,
	stamp,
	utf8Page,
} from './io.js'
import type { RunEvidenceScope, RunTextEvidenceReadResult } from './types.js'

const integer = z.number().int().nonnegative().safe()
export const textPointerSchema = entrySchema.pick({
	offset: true,
	length: true,
	sha256: true,
	seq: true,
	part: true,
})
const manifestSchema = z.object({
	version: z.literal(1),
	bytes: integer,
	chars: integer.optional(),
	chunkBytes: z.literal(EVIDENCE_CHUNK_BYTES),
	chunks: z
		.array(
			z.object({
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				filter: z.string().max(1400),
				characterOffset: integer.optional(),
			}),
		)
		.max(4096),
})

export interface TextSource {
	entry: IndexEntry
	bytes: number
	chars?: number
	retained: 'full' | 'preview'
	chunks: number
	mayMatch(chunk: number, query: string): boolean
	window(
		chunk: number,
		preceding?: boolean,
	): Promise<{ bytes: Buffer; offset: number; characterOffset?: number; searchFrom?: number }>
}

export async function sourceText(
	handle: FileHandle,
	pointer: z.infer<typeof textPointerSchema>,
	runDir: string,
	runId: string,
	budget: EvidenceBudget,
	verifiedRecord?: Buffer,
): Promise<TextSource> {
	const raw = verifiedRecord ?? (await readBytes(handle, pointer.offset, pointer.length, budget))
	if (digest(raw) !== pointer.sha256) throw new Error('Recorded tool evidence changed.')
	const event = JSON.parse(decode(raw))
	if (event.runId !== runId || event.seq !== pointer.seq)
		throw new Error('Recorded text identity changed.')
	const part = eventTexts(event)[pointer.part]
	if (!part) throw new Error('Recorded text part is unavailable.')
	const tool = event.type === 'tool_completed'
	const entry = entrySchema.parse({
		...pointer,
		source: part.source,
		...(tool
			? {
					toolName: z.string().parse(event.toolName),
					toolUseId: z.string().parse(event.toolUseId),
					isError: z.boolean().parse(event.isError),
					spill: event.outputSpillIntegrity,
				}
			: {}),
		truncated: tool && event.outputTruncated === true,
		filter: '',
	})

	if (!entry.spill) {
		const bytes = Buffer.from(part.text, 'utf8')
		return {
			entry,
			bytes: bytes.length,
			chars: part.text.length,
			retained: entry.truncated ? 'preview' : 'full',
			chunks: 1,
			mayMatch: () => true,
			window: async () => ({ bytes, offset: 0, characterOffset: 0 }),
		}
	}
	// Never follow a model/provider-controlled spill path from the event.
	if (!entry.toolUseId) throw new Error('Retained output has no tool identity.')
	const path = join(runDir, 'tool-output', `${digest(entry.toolUseId)}.txt`)
	const rawManifest = await readSmall(`${path}.manifest.json`, budget)
	if (digest(rawManifest) !== entry.spill) throw new Error('Retained output manifest changed.')
	const manifest = manifestSchema.parse(JSON.parse(decode(rawManifest)))
	if (manifest.chunks.length !== Math.ceil(manifest.bytes / EVIDENCE_CHUNK_BYTES))
		throw new Error('Incomplete retained output manifest.')
	return {
		entry,
		bytes: manifest.bytes,
		chars: manifest.chars,
		retained: 'full',
		chunks: Math.max(1, manifest.chunks.length),
		mayMatch: (chunk, query) =>
			manifest.chunks[chunk] ? mayContain(manifest.chunks[chunk].filter, query) : query === '',
		async window(chunk, preceding = false) {
			const file = await openEvidence(path)
			try {
				const before = await file.stat()
				if (before.size !== manifest.bytes) throw new Error('Retained output size changed.')
				const pieces: Buffer[] = []
				// A token boundary needs the previous code point. Authenticate its
				// entire chunk and charge that read; never trust an unverified byte.
				const first = preceding && chunk > 0 ? chunk - 1 : chunk
				for (let index = first; index < Math.min(chunk + 2, manifest.chunks.length); index++) {
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
				const ownedStart = (chunk - first) * EVIDENCE_CHUNK_BYTES
				let contentStart = ownedStart
				while (contentStart < all.length && ((all[contentStart] ?? 0) & 0xc0) === 0x80)
					contentStart++
				let start = contentStart
				if (preceding && chunk > 0) {
					start--
					while (start > 0 && ((all[start] ?? 0) & 0xc0) === 0x80) start--
				}
				const prefixChars = decode(all.subarray(start, contentStart)).length
				const characterOffset =
					manifest.chunks[chunk]?.characterOffset ?? (chunk === 0 ? 0 : undefined)
				return {
					bytes: utf8Page(
						all.subarray(start),
						ownedStart + EVIDENCE_CHUNK_BYTES + SEARCH_OVERLAP_BYTES - start,
					),
					offset: first * EVIDENCE_CHUNK_BYTES + start,
					characterOffset:
						characterOffset === undefined ? undefined : characterOffset - prefixChars,
					searchFrom: prefixChars,
				}
			} finally {
				await file.close()
			}
		},
	}
}

export async function readTextPage(
	source: TextSource,
	scope: RunEvidenceScope,
	offset: number,
	budget: EvidenceBudget,
): Promise<RunTextEvidenceReadResult> {
	const entry = source.entry
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
		source: entry.source,
		part: entry.part,
		characterOffset:
			window.characterOffset === undefined
				? undefined
				: window.characterOffset + decode(window.bytes.subarray(0, offset - window.offset)).length,
		totalChars: source.chars,
		toolName: entry.toolName,
		isError: entry.isError,
		retained: source.retained,
		text,
		byteOffset: offset,
		nextByteOffset: next < source.bytes ? next : null,
		totalBytes: source.bytes,
		scannedBytes: budget.bytes,
	}
}
