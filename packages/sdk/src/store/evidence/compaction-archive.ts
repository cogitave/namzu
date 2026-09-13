import { randomUUID } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RunEvent } from '../../types/run/events.js'
import type { CompactedToolMetadata } from './compaction-provenance.js'
import { compactedTexts } from './compaction-text.js'
import { digest, spillManifest } from './format.js'
import { RECORD_BYTES, decode, noLinks, openEvidence, stamp } from './io.js'

const integer = z.number().int().nonnegative().safe()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const role = z.enum(['system', 'user', 'assistant', 'tool'])
export const compactionArchiveSchema = z.object({
	type: z.literal('compaction_archive'),
	runId: z.string().uuid(),
	seq: integer.positive().optional(),
	iteration: integer,
	reason: z.enum(['threshold', 'overflow', 'manual']),
	archive: z.object({
		version: z.literal(1),
		id: z.string().uuid(),
		bytes: integer,
		sha256: hash,
		messageCount: integer,
		parts: z
			.array(
				z.object({
					role,
					manifest: hash,
					toolName: z.string().min(1).max(1024).optional(),
					isError: z.boolean().optional(),
				}),
			)
			.max(8192),
	}),
})

/** Internal storage encoding only; RunStore readers restore compaction_shed. */
export function compactionArchiveDirectory(runDir: string, id: string): string {
	return join(runDir, 'compaction-output', z.string().uuid().parse(id))
}

export function compactionPartPath(runDir: string, id: string, part: number): string {
	return join(compactionArchiveDirectory(runDir, id), `${integer.parse(part)}.txt`)
}

/** Keep JSONL index records bounded while preserving whole original messages. */
export async function retainCompactionRecord(
	event: RunEvent,
	runDir: string,
): Promise<RunEvent | z.infer<typeof compactionArchiveSchema>> {
	if (event.type !== 'compaction_shed') return event
	const { messages: removed, type: _type, ...envelope } = event
	const messageCount = removed.length
	const original = Buffer.from(JSON.stringify(event.messages), 'utf8')
	if (original.length <= 3 * 1024 * 1024) return event
	const texts = compactedTexts(event.messages)
	if (texts.length > 8192) throw new Error('Compaction archive exceeds 8192 textual parts.')
	// The same 4096-chunk ceiling the reader enforces for retained tool text.
	if (texts.some((part) => Buffer.byteLength(part.text, 'utf8') > 256 * 1024 * 1024))
		throw new Error('Compaction archive text exceeds 256 MiB per part.')
	const id = randomUUID()
	const dir = compactionArchiveDirectory(runDir, id)
	await noLinks(runDir)
	await mkdir(join(runDir, 'compaction-output'), { recursive: true, mode: 0o700 })
	await noLinks(join(runDir, 'compaction-output'))
	await mkdir(dir, { mode: 0o700 })
	await writeFile(join(dir, 'messages.json'), original, { flag: 'wx', mode: 0o600 })
	const parts: ({ role: z.infer<typeof role>; manifest: string } & CompactedToolMetadata)[] = []
	for (const [part, value] of texts.entries()) {
		const bytes = Buffer.from(value.text, 'utf8')
		const manifest = spillManifest(bytes)
		if (Buffer.byteLength(manifest, 'utf8') > RECORD_BYTES)
			throw new Error('Compaction text manifest exceeds its 4 MiB read limit.')
		const path = compactionPartPath(runDir, id, part)
		await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
		await writeFile(`${path}.manifest.json`, manifest, { flag: 'wx', mode: 0o600 })
		parts.push({
			role: value.role,
			manifest: digest(manifest),
			toolName: value.toolName,
			isError: value.isError,
		})
	}
	return {
		...envelope,
		...compactionArchiveSchema.parse({
			type: 'compaction_archive',
			runId: event.runId,
			seq: event.seq,
			iteration: event.iteration,
			reason: event.reason,
			archive: {
				version: 1,
				id,
				bytes: original.length,
				sha256: digest(original),
				messageCount,
				parts,
			},
		}),
	}
}

/** Full event readback is explicit and may load large bodies; search never calls this. */
export async function restoreCompactionRecord(
	record: Record<string, unknown>,
	runDir: string,
): Promise<Record<string, unknown>> {
	if (record.type !== 'compaction_archive') return record
	const saved = compactionArchiveSchema.parse(record)
	const path = join(compactionArchiveDirectory(runDir, saved.archive.id), 'messages.json')
	const file = await openEvidence(path)
	try {
		const before = await file.stat()
		if (before.size !== saved.archive.bytes) throw new Error('Compaction archive size changed.')
		const bytes = await file.readFile()
		if (
			stamp(before) !== stamp(await file.stat()) ||
			stamp(before) !== stamp(await lstat(path)) ||
			digest(bytes) !== saved.archive.sha256
		)
			throw new Error('Compaction archive bytes changed.')
		const messages: unknown = JSON.parse(decode(bytes))
		if (!Array.isArray(messages) || messages.length !== saved.archive.messageCount)
			throw new Error('Compaction archive message count changed.')
		const { archive: _archive, ...rest } = record
		return { ...rest, type: 'compaction_shed', messages }
	} finally {
		await file.close()
	}
}
