import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const CHUNK_BYTES = 64 * 1024

/** A hard input ceiling, independent of output windows and allow_large. */
export const TEXT_MAX_INPUT_BYTES = 32 * 1024 * 1024

/**
 * Read at most the limit plus one sentinel byte, even if the file grows after
 * stat. No allocation or request is derived from an untrusted file size.
 * The first bounded chunk can choose a stricter limit from the file signature.
 */
export async function readBoundedChunks(
	read: (offset: number, length: number) => Promise<Buffer>,
	maximum: number,
	signal?: AbortSignal,
	selectLimit?: (prefix: Buffer) => number,
): Promise<Buffer> {
	const chunks: Buffer[] = []
	let offset = 0
	let limit = maximum
	for (;;) {
		signal?.throwIfAborted()
		const length = Math.min(CHUNK_BYTES, limit + 1 - offset)
		const chunk = await read(offset, length)
		signal?.throwIfAborted()
		if (chunk.length > length)
			throw new Error('The file backend returned more bytes than the requested bounded range.')
		if (offset === 0 && selectLimit) limit = Math.min(maximum, selectLimit(chunk))
		offset += chunk.length
		if (offset > limit) throw inputTooLarge(limit)
		chunks.push(chunk)
		if (chunk.length < length) return Buffer.concat(chunks, offset)
	}
}

export async function readBoundedFile(
	path: string,
	maximum: number,
	signal?: AbortSignal,
	selectLimit?: (prefix: Buffer) => number,
): Promise<Buffer> {
	// O_NONBLOCK prevents a substituted FIFO from blocking open before fstat.
	signal?.throwIfAborted()
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
	try {
		const info = await file.stat()
		if (!info.isFile()) throw new Error('Read requires a regular file.')
		if (info.size > maximum) throw inputTooLarge(maximum)
		return await readBoundedChunks(
			async (offset, length) => {
				const buffer = Buffer.allocUnsafe(length)
				let used = 0
				while (used < length) {
					signal?.throwIfAborted()
					const { bytesRead } = await file.read(buffer, used, length - used, offset + used)
					if (bytesRead === 0) break
					used += bytesRead
				}
				return buffer.subarray(0, used)
			},
			maximum,
			signal,
			(prefix) => {
				const limit = selectLimit?.(prefix) ?? maximum
				if (info.size > limit) throw inputTooLarge(limit)
				return limit
			},
		)
	} finally {
		await file.close()
	}
}

function inputTooLarge(limit: number): Error {
	return new Error(
		`File exceeds the bounded read limit (${limit} bytes). Extract a smaller file with a shell command.`,
	)
}
