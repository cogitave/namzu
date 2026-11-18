import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProjectFileContent } from '../shared/protocol.js'
import { ProjectPathError } from './project-files.js'

/**
 * Which files a conversation's preview pane may read. Two kinds of path are allowed, and nothing
 * else: a file inside the conversation's own work folder, and a file one of its turns wrote (its
 * edit receipts name it), wherever that is. The renderer names a path; this decides, after
 * symlinks are resolved, so a path that merely looks inside the folder cannot reach out of it.
 */

const outside = () => new ProjectPathError('That file is not one this conversation wrote.')
const caseFold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)

function inside(root: string, target: string): boolean {
	const path = relative(root, target)
	return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export interface OutputAccess {
	/** The conversation's work folder, as the host recorded it. */
	root: string
	/** Absolute paths the conversation's receipts name. */
	written: readonly string[]
}

export interface ResolvedOutput {
	/** The real file on disk. */
	absolute: string
	/** Set when the file is inside the work folder: the path relative to it, '/' separated. */
	inFolder?: string
}

/** The file `path` names for this conversation, or a plain refusal. */
export async function resolveOutput(access: OutputAccess, path: unknown): Promise<ResolvedOutput> {
	if (typeof path !== 'string' || path.length === 0 || path.length > 1024) throw outside()
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(path)) throw outside()
	let real: string
	let root: string
	try {
		root = await realpath(access.root)
		real = await realpath(isAbsolute(path) ? resolve(path) : resolve(root, path))
	} catch {
		throw new ProjectPathError('That file was not found.')
	}
	const folderPath = relative(root, real)
	// .git is never a preview, in the folder or through a link into it.
	const hidden = folderPath.split(sep).some((part) => part.toLowerCase() === '.git')
	if (inside(root, real)) {
		if (hidden) throw outside()
		return { absolute: real, inFolder: folderPath.split(sep).join('/') }
	}
	for (const candidate of access.written) {
		try {
			if (caseFold(await realpath(candidate)) === caseFold(real)) return { absolute: real }
		} catch {
			// A receipt for a file that is gone names nothing.
		}
	}
	throw outside()
}

/** The content of an allowed file, read with the project reader's own limits. */
export async function readOutput(
	access: OutputAccess,
	path: unknown,
	reader: { read(root: string, path: unknown): Promise<ProjectFileContent> },
): Promise<ProjectFileContent> {
	const found = await resolveOutput(access, path)
	if (found.inFolder !== undefined) return reader.read(await realpath(access.root), found.inFolder)
	return reader.read(dirname(found.absolute), basename(found.absolute))
}
