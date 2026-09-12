import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, parse, resolve, sep } from 'node:path'

export const PAGE_BYTES = 8 * 1024 * 1024
export const RECORD_BYTES = 4 * 1024 * 1024
export class EvidencePageLimit extends Error {}
export interface EvidenceBudget {
	bytes: number
	signal?: AbortSignal
}

export function stamp(stat: {
	dev: number
	ino: number
	size: number
	mtimeMs: number
	ctimeMs: number
}): string {
	return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

export async function noLinks(path: string): Promise<void> {
	const absolute = resolve(path)
	let current = parse(absolute).root
	for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
		current = join(current, part)
		if ((await lstat(current)).isSymbolicLink()) throw new Error('Evidence symlinks are refused.')
	}
}

export async function openEvidence(path: string): Promise<FileHandle> {
	await noLinks(path)
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	if (!(await handle.stat()).isFile()) {
		await handle.close()
		throw new Error('Evidence must be a regular file.')
	}
	return handle
}

export async function readBytes(
	handle: FileHandle,
	offset: number,
	length: number,
	budget: EvidenceBudget,
): Promise<Buffer> {
	budget.signal?.throwIfAborted()
	if (budget.bytes + length > PAGE_BYTES) throw new EvidencePageLimit()
	const bytes = Buffer.alloc(length)
	let received = 0
	while (received < length) {
		budget.signal?.throwIfAborted()
		const { bytesRead } = await handle.read(
			bytes,
			received,
			Math.min(65_536, length - received),
			offset + received,
		)
		budget.bytes += bytesRead
		if (!bytesRead) throw new Error('Evidence shortened while reading.')
		received += bytesRead
	}
	return bytes
}

export async function readSmall(
	path: string,
	budget: EvidenceBudget,
	limit = RECORD_BYTES,
): Promise<Buffer> {
	const handle = await openEvidence(path)
	try {
		const before = await handle.stat()
		if (before.size > limit) throw new Error('Evidence record exceeds its read limit.')
		const bytes = await readBytes(handle, 0, before.size, budget)
		if (stamp(before) !== stamp(await handle.stat()))
			throw new Error('Evidence changed during read.')
		return bytes
	} finally {
		await handle.close()
	}
}

export function decode(bytes: Uint8Array): string {
	return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

export function utf8Page(bytes: Buffer, limit: number): Buffer {
	let end = Math.min(bytes.length, limit)
	while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
	return bytes.subarray(0, end)
}
