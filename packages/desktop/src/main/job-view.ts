/**
 * What the renderer is told about a background job. The engine's record carries the end time as
 * `exitedAt`; the renderer reads it as `completedAt`, and reads at most the tail of a job's output.
 */

/** The last bytes of a job's output the window reads; older output stays in the engine. */
export const JOB_TAIL_BYTES = 64 * 1024

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** A jobs list with each ended job's end time named `completedAt`. */
export function jobRows(raw: unknown): unknown[] {
	if (!Array.isArray(raw)) return []
	return raw.map((row) => {
		if (!record(row) || row.completedAt !== undefined) return row
		const end = row.exitedAt
		return typeof end === 'number' && Number.isFinite(end) ? { ...row, completedAt: end } : row
	})
}

export interface JobTail {
	output: string
	truncated: boolean
	/** Bytes the engine still holds for this job, so the window can slow its reads on a large output. */
	size: number
}

/** The tail of one read: at most `JOB_TAIL_BYTES` bytes, cut at a character boundary. */
export function jobTail(chunk: unknown, droppedBytes: unknown, limit = JOB_TAIL_BYTES): JobTail {
	const text = typeof chunk === 'string' ? chunk : ''
	const bytes = Buffer.from(text, 'utf8')
	const dropped = typeof droppedBytes === 'number' && droppedBytes > 0
	if (bytes.length <= limit) return { output: text, truncated: dropped, size: bytes.length }
	let start = bytes.length - limit
	// A continuation byte (10xxxxxx) starts in the middle of a character: step past it.
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
	return { output: bytes.subarray(start).toString('utf8'), truncated: true, size: bytes.length }
}
