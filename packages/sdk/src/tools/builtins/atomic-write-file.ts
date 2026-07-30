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

async function syncDirectory(directory: string): Promise<void> {
	let handle: FileHandle | undefined
	try {
		handle = await open(directory, 'r')
		await handle.sync()
	} finally {
		await handle?.close().catch(() => undefined)
	}
}
