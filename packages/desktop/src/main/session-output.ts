import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { previewLine } from '../shared/output-preview-line.js'
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
	/**
	 * Absolute paths the conversation's receipts name. An entry may carry the real path the file
	 * had when it was handed over; a path that now leads anywhere else is not that file.
	 */
	written: readonly (string | { path: string; real: string })[]
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
	for (const entry of access.written) {
		const candidate = typeof entry === 'string' ? entry : entry.path
		try {
			const now = caseFold(await realpath(candidate))
			if (typeof entry !== 'string' && now !== caseFold(entry.real)) continue
			if (now === caseFold(real)) return { absolute: real }
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

/** What a card shows about a file besides its name: how big it is, and a line of its start. */
export interface OutputDetail {
	path: string
	/** Bytes; absent when the file is gone. */
	size?: number
	/** The file is no longer where it was. */
	missing?: true
	/** The first heading, sentence or line of code. */
	preview?: string
}

const MAX_DETAIL_PATHS = 40
const PREVIEW_BYTES = 4096

/**
 * Size and a one-line start for each path, for the cards. Every path goes through the same check
 * as a read, so a path the conversation did not write is answered as missing, never described.
 */
export async function describeOutputs(
	access: OutputAccess,
	paths: unknown,
	deps: {
		stat(path: string): Promise<{ size: number } | undefined>
		head(path: string, bytes: number): Promise<string>
	},
): Promise<OutputDetail[]> {
	if (!Array.isArray(paths)) throw outside()
	const result: OutputDetail[] = []
	for (const path of paths.slice(0, MAX_DETAIL_PATHS)) {
		if (typeof path !== 'string') continue
		try {
			const found = await resolveOutput(access, path)
			const info = await deps.stat(found.absolute)
			if (!info) {
				result.push({ path, missing: true })
				continue
			}
			const line = previewLine(path, await deps.head(found.absolute, PREVIEW_BYTES).catch(() => ''))
			result.push({ path, size: info.size, ...(line ? { preview: line } : {}) })
		} catch {
			result.push({ path, missing: true })
		}
	}
	return result
}

/**
 * Copies a file the conversation made to a place the person chooses in the system's own save
 * dialog. The source is resolved by the same check as a read; the destination is whatever the
 * dialog returned, so the window never names a path to write.
 */
export async function saveOutputCopy(
	access: OutputAccess,
	path: unknown,
	deps: {
		choose(defaultName: string): Promise<string | undefined>
		copy(from: string, to: string): Promise<void>
	},
): Promise<{ saved: boolean }> {
	const found = await resolveOutput(access, path)
	const target = await deps.choose(basename(found.absolute))
	if (!target) return { saved: false }
	await deps.copy(found.absolute, target)
	return { saved: true }
}
