import { constants } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { type SessionRecord, parseSessionLogLine } from '@namzu/sdk'

/**
 * A bounded read of one session log's first record.
 *
 * `session_started` says which project and tenant the session was opened
 * under, and it is small, so a caller that only needs to confirm a log's scope
 * never reads the whole log. The hash chain is not verified here: a writer
 * re-verifies it before it appends.
 */

/** The largest first record read: `session_started` is small. */
export const SESSION_HEAD_BYTES = 65_536

export type SessionStartRecord = Extract<SessionRecord, { type: 'session_started' }>

/** Refuse a symbolic link anywhere between the state root and the log. */
async function assertNoLinks(root: string, path: string): Promise<void> {
	const suffix = relative(root, path)
	if (suffix === '..' || suffix.startsWith(`..${sep}`) || suffix === '')
		throw new Error('Session log path is outside the state root.')
	let current = root
	for (const part of ['', ...suffix.split(sep)]) {
		current = join(current, part)
		if ((await lstat(current)).isSymbolicLink())
			throw new Error('Session log symlinks are refused.')
	}
}

async function openLog(
	root: string,
	path: string,
): Promise<{ file: FileHandle; size: number } | null> {
	try {
		await assertNoLinks(root, path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
	const file = await open(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
	)
	const stat = await file.stat()
	if (!stat.isFile()) {
		await file.close()
		throw new Error('A session log must be a regular file.')
	}
	return { file, size: stat.size }
}

async function readRange(file: FileHandle, offset: number, length: number): Promise<Buffer> {
	const bytes = Buffer.alloc(length)
	let read = 0
	while (read < length) {
		const { bytesRead } = await file.read(bytes, read, length - read, offset + read)
		if (!bytesRead) break
		read += bytesRead
	}
	return bytes.subarray(0, read)
}

/**
 * The log's `session_started` record, which says which project and tenant
 * the session was opened under. `null` when the log does not exist.
 */
export async function readSessionStart(
	root: string,
	path: string,
	signal?: AbortSignal,
): Promise<SessionStartRecord | null> {
	signal?.throwIfAborted()
	const opened = await openLog(root, path)
	if (!opened) return null
	try {
		const head = await readRange(opened.file, 0, Math.min(opened.size, SESSION_HEAD_BYTES))
		const end = head.indexOf(0x0a)
		if (end < 0) throw new Error('The session log has no complete first record.')
		const { record } = parseSessionLogLine(head.subarray(0, end + 1))
		if (record.type !== 'session_started' || record.seq !== 1)
			throw new Error('The session log does not start with session_started.')
		return record
	} finally {
		await opened.file.close()
	}
}
