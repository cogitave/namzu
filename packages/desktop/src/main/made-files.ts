import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isMadeFileKind } from '../shared/output-files.js'

/**
 * Finding the files a turn made by running something (a command, a script, a tool) rather than by
 * writing them through the edit tools. The folder is listed before and after the turn, and a
 * result-kind file that is new or changed is a made file. The walk is bounded in depth, in files
 * and in time, and never enters a folder that holds tools' own working data.
 */

export interface FileStamp {
	size: number
	modified: number
}
export type FolderSnapshot = Map<string, FileStamp>

export interface MadeFile {
	/** Absolute path. */
	path: string
	size: number
	modified: number
}

const SKIPPED = new Set([
	'node_modules',
	'dist',
	'build',
	'out',
	'target',
	'coverage',
	'vendor',
	'__pycache__',
	'venv',
	'env',
])
export const MAX_DEPTH = 6
export const MAX_ENTRIES = 4000

export interface FolderReader {
	list(dir: string): Promise<{ name: string; directory: boolean; file: boolean }[]>
	stat(path: string): Promise<FileStamp | undefined>
}

export const systemFolderReader: FolderReader = {
	async list(dir) {
		const entries = await readdir(dir, { withFileTypes: true })
		return entries.map((entry) => ({
			name: entry.name,
			directory: entry.isDirectory(),
			file: entry.isFile(),
		}))
	},
	async stat(path) {
		try {
			const info = await stat(path)
			return { size: info.size, modified: info.mtimeMs }
		} catch {
			return undefined
		}
	},
}

export const MAX_FOLDERS = 2000
/** A file system stamps times coarsely; a file this close before the turn began still counts. */
export const START_SLACK_MS = 2000

export interface FolderScan {
	files: FolderSnapshot
	/** False when a limit cut the walk short, so the list may miss files. */
	complete: boolean
}

/**
 * Result-kind files under `root`, with their size and time. Anything unreadable is skipped. Only
 * result files count toward the file limit, and names are walked in sorted order so two walks of
 * the same folder cut at the same place.
 */
export async function scanFolder(
	root: string,
	reader: FolderReader = systemFolderReader,
	limits: { depth?: number; entries?: number; folders?: number } = {},
): Promise<FolderScan> {
	const maxDepth = limits.depth ?? MAX_DEPTH
	const maxEntries = limits.entries ?? MAX_ENTRIES
	const maxFolders = limits.folders ?? MAX_FOLDERS
	const found: FolderSnapshot = new Map()
	let folders = 0
	let complete = true
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (!complete) return
		if (folders >= maxFolders) {
			complete = false
			return
		}
		folders += 1
		let entries: Awaited<ReturnType<FolderReader['list']>>
		try {
			entries = await reader.list(dir)
		} catch {
			return
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		for (const entry of entries) {
			if (!complete) return
			// A folder or file that starts with a dot is the tool's own (.git, caches, settings).
			if (entry.name.startsWith('.')) continue
			const path = join(dir, entry.name)
			if (entry.directory) {
				if (depth < maxDepth && !SKIPPED.has(entry.name)) await walk(path, depth + 1)
			} else if (entry.file && isMadeFileKind(entry.name)) {
				if (found.size >= maxEntries) {
					complete = false
					return
				}
				const stamp = await reader.stat(path)
				if (stamp) found.set(path, stamp)
			}
		}
	}
	await walk(root, 0)
	return { files: found, complete }
}

/** `scanFolder(...).files`, for a caller that does not care whether the walk was cut short. */
export async function snapshotFolder(
	root: string,
	reader: FolderReader = systemFolderReader,
	limits: { depth?: number; entries?: number; folders?: number } = {},
): Promise<FolderSnapshot> {
	return (await scanFolder(root, reader, limits)).files
}

/** Files whose time falls inside the turn: written at or after it began. */
export function madeSince(files: FolderSnapshot, startedAt: number): MadeFile[] {
	const made: MadeFile[] = []
	for (const [path, stamp] of files)
		if (stamp.modified >= startedAt - START_SLACK_MS)
			made.push({ path, size: stamp.size, modified: stamp.modified })
	return made.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path))
}

/** Files in `after` that `before` did not have, or has with another size or time. */
export function madeBetween(before: FolderSnapshot, after: FolderSnapshot): MadeFile[] {
	const made: MadeFile[] = []
	for (const [path, stamp] of after) {
		const old = before.get(path)
		if (old && old.size === stamp.size && old.modified === stamp.modified) continue
		made.push({ path, size: stamp.size, modified: stamp.modified })
	}
	return made.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path))
}
