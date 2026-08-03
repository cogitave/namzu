import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

interface AtomicWriteHooks {
	/** Internal fault-injection seam; production callers never pass this. */
	beforeCommit?: () => Promise<void>
}

/**
 * Commit a complete file body without exposing a truncated destination.
 *
 * The temp file lives beside the destination so rename stays on one
 * filesystem. A failed pre-commit write leaves the original untouched.
 */
export async function atomicWriteFile(
	filePath: string,
	content: string,
	hooks: AtomicWriteHooks = {},
): Promise<void> {
	const directory = dirname(filePath)
	await mkdir(directory, { recursive: true })

	const existingMode = await stat(filePath)
		.then((value) => value.mode)
		.catch(() => undefined)
	const tempPath = join(
		directory,
		`.${basename(filePath)}.namzu-${process.pid}-${randomUUID()}.tmp`,
	)
	let handle: FileHandle | undefined
	let committed = false

	try {
		handle = await open(tempPath, 'wx', existingMode ?? 0o666)
		await handle.writeFile(content, 'utf-8')
		await handle.sync()
		await handle.close()
		handle = undefined
		await hooks.beforeCommit?.()
		await rename(tempPath, filePath)
		committed = true
		await syncDirectory(directory)
	} finally {
		await handle?.close().catch(() => undefined)
		if (!committed) await unlink(tempPath).catch(() => undefined)
	}
}

/**
 * Best-effort, and only after the rename has already committed.
 *
 * Syncing the directory is what makes the RENAME survive a power loss on a
 * POSIX filesystem. Not every platform permits it — opening a directory and
 * calling fsync raises `EPERM` on Windows — and there the whole builtin was
 * unusable: every `edit` and every `write` failed with `EPERM: operation not
 * permitted, fsync` after correctly writing the file.
 *
 * Swallowing is right here and nowhere else in this file. By this point the
 * destination already holds the complete new body; the only thing still at
 * stake is durability across an OS-level crash, and on a platform that
 * refuses the call there is no second way to ask. Failing the write would
 * trade a durability refinement for a guaranteed error on every write.
 *
 * The sibling in `utils/atomic-write.ts` — the one the disk stores use, and
 * the one that has run on this platform all along — does not sync the
 * directory at all.
 */
async function syncDirectory(directory: string): Promise<void> {
	let handle: FileHandle | undefined
	try {
		handle = await open(directory, 'r')
		await handle.sync()
	} catch {
		// Unsupported on this platform; the rename already landed.
	} finally {
		await handle?.close().catch(() => undefined)
	}
}
