import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { type FileHandle, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import nodePath, { basename, dirname, join, sep } from 'node:path'

/** A write refused because its path runs through a symbolic link or out of its root. */
export class UnsafeWritePathError extends Error {
	override readonly name = 'UnsafeWritePathError'
}

export interface AtomicWriteOptions {
	/** Internal fault-injection seam; production callers never pass this. */
	beforeCommit?: () => Promise<void>
	/** The permission bits of a new file; an existing file keeps its own mode when this is left out. */
	mode?: number
	/**
	 * Never write through a symbolic link below this folder. Every component of
	 * the path under `refuseLinksBelow` that exists is looked at with `lstat`: a
	 * link anywhere (a folder or the file itself) is refused with
	 * {@link UnsafeWritePathError}, and the real path of the deepest existing
	 * folder must stay inside the real `refuseLinksBelow`. The folder itself is
	 * trusted (it may be a link its owner made on purpose). The check runs before
	 * anything is created and again just before the rename. Left out, the write
	 * goes THROUGH a link and keeps it, which is what the file tools mean.
	 */
	refuseLinksBelow?: string
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}

function isInside(root: string, path: string): boolean {
	const rel = nodePath.relative(root, path)
	return rel === '' || (!nodePath.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertNoLinkBelow(anchor: string, file: string): void {
	const rel = nodePath.relative(anchor, file)
	if (rel === '' || nodePath.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
		throw new UnsafeWritePathError(`${file} is not inside ${anchor}.`)
	}
	let current = anchor
	let deepest = anchor
	for (const part of rel.split(sep)) {
		current = join(current, part)
		const stat = lstatOrUndefined(current)
		if (stat === undefined) break
		if (stat.isSymbolicLink()) {
			throw new UnsafeWritePathError(
				`${current} is a symbolic link; it is never written through. Remove the link or save somewhere else.`,
			)
		}
		deepest = current
	}
	if (!isInside(realOrSelf(anchor), realOrSelf(deepest))) {
		throw new UnsafeWritePathError(`${file} resolves outside ${anchor}; nothing was written.`)
	}
}

/**
 * Commit a complete file body without exposing a truncated destination.
 *
 * The temp file lives beside the destination so rename stays on one
 * filesystem. A failed pre-commit write leaves the original untouched.
 */
export async function atomicWriteFile(
	requestedPath: string,
	content: string,
	hooks: AtomicWriteOptions = {},
): Promise<void> {
	// Write THROUGH a symlink, not over it. `rename` replaces whatever sits
	// at the destination, so committing onto a link path swaps the link for
	// a regular file: the link is gone, and every other path that pointed
	// through it now reads stale content. Resolving first keeps the link and
	// updates what it points at, which is what a caller editing a linked
	// file means. A path that does not exist yet resolves to itself.
	const anchor = hooks.refuseLinksBelow
	if (anchor !== undefined) assertNoLinkBelow(anchor, requestedPath)
	const filePath =
		anchor === undefined ? await realpath(requestedPath).catch(() => requestedPath) : requestedPath
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
		handle = await open(tempPath, 'wx', hooks.mode ?? existingMode ?? 0o666)
		await handle.writeFile(content, 'utf-8')
		await handle.sync()
		await handle.close()
		handle = undefined
		await hooks.beforeCommit?.()
		if (anchor !== undefined) assertNoLinkBelow(anchor, filePath)
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
