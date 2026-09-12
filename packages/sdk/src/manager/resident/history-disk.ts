import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const RECORD_BYTES = 4 * 1024 * 1024

export interface ResidentHistoryReadBudget {
	remaining: number
	bytesRead: number
	signal?: AbortSignal
}

export class ResidentHistoryPageLimit extends Error {}

/** Bounded read of an immutable record in a private host-owned hierarchy. */
export async function readResidentHistoryRecord(
	root: string,
	path: string,
	budget: ResidentHistoryReadBudget,
): Promise<unknown> {
	budget.signal?.throwIfAborted()
	const base = resolve(root)
	const suffix = relative(base, resolve(path))
	if (suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('Invalid history path.')
	let current = base
	for (const part of ['', ...suffix.split(sep).filter(Boolean)]) {
		current = join(current, part)
		if ((await lstat(current)).isSymbolicLink()) throw new Error('History symlinks are refused.')
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > RECORD_BYTES)
			throw new Error('History record is not a bounded regular file.')
		if (before.size > budget.remaining) throw new ResidentHistoryPageLimit()
		const bytes = Buffer.alloc(before.size)
		let offset = 0
		while (offset < bytes.length) {
			budget.signal?.throwIfAborted()
			const { bytesRead } = await handle.read(
				bytes,
				offset,
				Math.min(64 * 1024, bytes.length - offset),
				offset,
			)
			budget.remaining -= bytesRead
			budget.bytesRead += bytesRead
			if (!bytesRead) throw new Error('History record shortened during read.')
			offset += bytesRead
		}
		budget.signal?.throwIfAborted()
		const after = await handle.stat()
		if (
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			throw new Error('History record changed during read.')
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} finally {
		await handle.close()
	}
}
