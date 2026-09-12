import type { FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import { digest } from './format.js'
import { eventTexts } from './index-page.js'
import { RECORD_BYTES, decode, openEvidence, readBytes } from './io.js'

const integer = z.number().int().nonnegative().safe()
export const recordPointerSchema = z.object({
	offset: integer,
	length: integer.positive().max(RECORD_BYTES),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	seq: integer.positive(),
})
export type RecordPointer = z.infer<typeof recordPointerSchema>

/** Malformed content must still be visited and rejected by the reader. */
export function hasEvidenceText(event: Record<string, unknown>): boolean {
	try {
		return eventTexts(event).length > 0
	} catch {
		return true
	}
}

/** Validate links even when a text-only traversal skips intervening operational records. */
export function recordPredecessors(event: Record<string, unknown>, pointer: RecordPointer) {
	let previous: RecordPointer | null = null
	let incomplete = false
	if (event.previousRecord != null) {
		previous = recordPointerSchema.parse(event.previousRecord)
		if (previous.offset + previous.length !== pointer.offset || previous.seq + 1 !== pointer.seq)
			throw new Error('Invalid text integrity chain.')
	} else if (pointer.seq === 1) {
		if (pointer.offset !== 0 || event.type !== 'run_started')
			throw new Error('Invalid transcript start.')
	} else {
		incomplete = true
	}
	let next = previous
	if (Object.hasOwn(event, 'previousTextRecord')) {
		next = recordPointerSchema.nullable().parse(event.previousTextRecord)
		if (
			(next === null && previous !== null) ||
			(next !== null &&
				(previous === null ||
					next.seq >= pointer.seq ||
					next.offset + next.length > pointer.offset ||
					(next.seq === previous.seq &&
						(next.offset !== previous.offset ||
							next.length !== previous.length ||
							next.sha256 !== previous.sha256))))
		)
			throw new Error('Invalid text predecessor link.')
	}
	return { previous, next, incomplete }
}

/** Bootstrap only the last complete record, never load a growing log to capture a boundary. */
export async function transcriptTail(
	path: string,
	runId: string,
): Promise<{ tip: RecordPointer; textTip?: RecordPointer | null } | undefined> {
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
		let event: Record<string, unknown> | null
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
		if (!pointer.success) return undefined
		const tip = pointer.data
		// Starts, gaps and malformed records remain traversal barriers. They may
		// never disappear behind a later text link after reopening the writer.
		let textTip: RecordPointer | null | undefined = tip
		try {
			const links = recordPredecessors(event, tip)
			if (!hasEvidenceText(event) && links.previous !== null)
				textTip = Object.hasOwn(event, 'previousTextRecord') ? links.next : undefined
		} catch {
			// Keep the tail itself; retrieval will reject its malformed links.
		}
		return { tip, textTip }
	} finally {
		await handle.close()
	}
}
