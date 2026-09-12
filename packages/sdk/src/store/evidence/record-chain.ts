import type { FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import { digest } from './format.js'
import { RECORD_BYTES, decode, openEvidence, readBytes } from './io.js'

const integer = z.number().int().nonnegative().safe()
export const recordPointerSchema = z.object({
	offset: integer,
	length: integer.positive().max(RECORD_BYTES),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	seq: integer.positive(),
})
export type RecordPointer = z.infer<typeof recordPointerSchema>

/** Bootstrap only the last complete record, never load a growing log to capture a boundary. */
export async function transcriptTail(
	path: string,
	runId: string,
): Promise<RecordPointer | undefined> {
	let handle: FileHandle
	try {
		handle = await openEvidence(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
	try {
		const stat = await handle.stat()
		if (!stat.size) return undefined
		const offset = Math.max(0, stat.size - RECORD_BYTES)
		const tail = await readBytes(handle, offset, stat.size - offset, { bytes: 0 })
		if (tail.at(-1) !== 10) return undefined
		const start = tail.lastIndexOf(10, tail.length - 2) + 1
		if (start === 0 && offset !== 0) return undefined
		const raw = tail.subarray(start)
		let event: { runId?: unknown; seq?: unknown } | null
		try {
			event = JSON.parse(decode(raw))
		} catch {
			return undefined
		}
		if (event?.runId !== runId) return undefined
		const pointer = recordPointerSchema.safeParse({
			offset: offset + start,
			length: raw.length,
			sha256: digest(raw),
			seq: event.seq,
		})
		return pointer.success ? pointer.data : undefined
	} finally {
		await handle.close()
	}
}
