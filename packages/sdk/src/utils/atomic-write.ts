import { randomBytes } from 'node:crypto'
import { type FileHandle, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write-then-rename, with a sidecar name no other writer can pick.
 *
 * The rename is what makes the write atomic — a reader sees the old file or
 * the new one, never a half-written one. The sidecar it renames FROM has to
 * be private to this write, and in six stores it was a fixed
 * `${path}.tmp`.
 *
 * Two writers of the same record then shared one scratch file: both opened
 * it, both wrote into it, and the first `rename` published whatever mixture
 * had landed while the second renamed a file that was no longer there. The
 * result is the failure atomic writes exist to prevent, arrived at through
 * the mechanism meant to prevent it.
 *
 * This is not hypothetical for this SDK. The cross-process park and unpark
 * handoff — one process suspending a run and another resuming it — is a
 * design where two processes legitimately touch the same records, and it is
 * the feature these stores exist to serve. One store already got this
 * right; the rest inherited the fixed name.
 *
 * The suffix carries the pid (distinct per process), a counter (distinct
 * within a process, including within one millisecond) and a few random
 * bytes (distinct across hosts sharing a network mount, where a pid can
 * repeat).
 */

let counter = 0

export function temporaryPathFor(filePath: string): string {
	counter = (counter + 1) % Number.MAX_SAFE_INTEGER
	return `${filePath}.${process.pid}.${counter}.${randomBytes(4).toString('hex')}.tmp`
}

/**
 * Publish `content` atomically.
 *
 * A failed write removes its own sidecar. Leaving it behind would litter
 * the store with files that look like records to anything scanning the
 * directory, and the next attempt would not reuse it anyway.
 */
export async function atomicWriteFile(
	filePath: string,
	content: string,
	options: { readonly mode?: number } = {},
): Promise<void> {
	const tempPath = temporaryPathFor(filePath)
	try {
		// The mode is applied when the sidecar is created, so the published
		// file never exists with wider permissions, not even for a moment.
		await writeFile(
			tempPath,
			content,
			options.mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode: options.mode },
		)
		await renameWithRetry(tempPath, filePath)
	} catch (err) {
		await unlink(tempPath).catch(() => undefined)
		throw err
	}
}

/**
 * Publish `content` atomically AND durably: when this resolves, the new body
 * and the rename that published it are on stable storage.
 *
 * {@link atomicWriteFile} survives a process crash — a reader sees the old
 * file or the new one — but not a power loss: without an fsync the kernel may
 * not have written the new body, or the directory entry that names it, when
 * the machine stops. For a record that is about to become the ONLY thing
 * pointing at some data (the older copy of which the caller deletes next),
 * that is the difference between losing an update and losing the record.
 *
 * Costs two fsyncs, so it is for rare writes. On Windows, where a directory
 * cannot be opened for fsync, the directory entry is left to the filesystem;
 * see {@link syncDirectory}.
 */
export async function durableWriteFile(filePath: string, content: string): Promise<void> {
	const tempPath = temporaryPathFor(filePath)
	let handle: FileHandle | undefined
	try {
		handle = await open(tempPath, 'wx')
		await handle.writeFile(content, 'utf-8')
		await handle.sync()
		await handle.close()
		handle = undefined
		await renameWithRetry(tempPath, filePath)
	} catch (err) {
		await handle?.close().catch(() => undefined)
		await unlink(tempPath).catch(() => undefined)
		throw err
	}
	await syncDirectory(dirname(filePath))
}

/**
 * Make the entries of `directory` — a rename into it, a file created in it —
 * survive a power loss.
 *
 * A failure is thrown on POSIX: a caller that asked for durability and did not
 * get it must not go on to delete what the durable copy was meant to replace.
 * On Windows opening a directory for fsync raises `EPERM` and there is no
 * other way to ask, so there it does nothing; NTFS journals its metadata.
 */
export async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === 'win32') return
	const handle = await open(directory, 'r')
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

/** Transient on Windows while another handle still holds the target. */
const CONTENDED = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 5

/**
 * Rename, retrying briefly while the target is contended.
 *
 * Replacing an existing file by rename is unconditional on POSIX and not
 * on Windows, where a concurrent writer holding the target makes the call
 * fail with `EPERM` — momentarily, for as long as the other rename takes.
 * Two processes writing the same record is precisely the case this whole
 * helper exists for, so treating that as a hard failure would hand back an
 * error for a situation that resolves itself in microseconds.
 *
 * Bounded and short on purpose. A genuine permission problem is not
 * transient, and retrying it forever would turn a clear failure into a
 * hang; five attempts distinguishes contention from denial without
 * pretending to fix the latter.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to)
			return
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? ''
			if (!CONTENDED.has(code) || attempt >= RENAME_ATTEMPTS) throw err
			await new Promise((resolve) => setTimeout(resolve, attempt))
		}
	}
}
