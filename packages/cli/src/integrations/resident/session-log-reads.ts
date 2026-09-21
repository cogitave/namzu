import { constants } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { type SessionRecord, type TurnId, parseSessionLogLine } from '@namzu/sdk'

/**
 * Bounded reads of one resident step's session log.
 *
 * A resident step is one session with one turn, and the log is the only
 * record of what that turn spent. Inspection must not read a whole log —
 * `inspectResidentConsumption` reserves a fixed allowance per attempt before
 * asking — so these read the first record and a window at the end, never
 * more than {@link SESSION_LOG_READ_BYTES} in total. The hash chain is not
 * verified here: this is accounting, as the receipts it is cross-checked
 * against are, and a writer re-verifies the chain before it appends.
 */

/** The largest first record read: `session_started` is small. */
export const SESSION_HEAD_BYTES = 65_536
/** The window at the end of the log searched for the turn's terminal record. */
export const SESSION_TAIL_BYTES = 655_360
/** Worst case for one {@link readSessionStart} plus one {@link readTurnSettlement}. */
export const SESSION_LOG_READ_BYTES = SESSION_HEAD_BYTES + SESSION_TAIL_BYTES

export type SessionStartRecord = Extract<SessionRecord, { type: 'session_started' }>
export type TurnSettlementRecord = Extract<
	SessionRecord,
	{ type: 'turn_completed' | 'turn_failed' }
>

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

/**
 * The record that settled `turnId` (`turn_completed` or `turn_failed`),
 * searched for from the end of the log. `null` when the log does not exist,
 * when the turn never settled, or when its settlement is not within the
 * last {@link SESSION_TAIL_BYTES}.
 */
export async function readTurnSettlement(
	root: string,
	path: string,
	turnId: TurnId,
	signal?: AbortSignal,
): Promise<TurnSettlementRecord | null> {
	signal?.throwIfAborted()
	const opened = await openLog(root, path)
	if (!opened) return null
	try {
		const offset = Math.max(0, opened.size - SESSION_TAIL_BYTES)
		const tail = await readRange(opened.file, offset, opened.size - offset)
		signal?.throwIfAborted()
		// The first line of a window that does not start at byte 0 may be cut;
		// only lines that begin after a newline inside the window are whole.
		let start = offset === 0 ? 0 : tail.indexOf(0x0a) + 1
		if (offset > 0 && start === 0) return null
		const lines: Buffer[] = []
		for (let end = tail.indexOf(0x0a, start); end >= 0; end = tail.indexOf(0x0a, start)) {
			lines.push(tail.subarray(start, end + 1))
			start = end + 1
		}
		for (let index = lines.length - 1; index >= 0; index--) {
			const { record } = parseSessionLogLine(lines[index] as Buffer)
			if (record.turnId !== turnId) continue
			if (record.type === 'turn_completed' || record.type === 'turn_failed') return record
			if (record.type === 'turn_started') return null
		}
		return null
	} finally {
		await opened.file.close()
	}
}
