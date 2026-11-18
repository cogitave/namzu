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

/** Result-kind files under `root`, with their size and time. Anything unreadable is skipped. */
export async function snapshotFolder(
	root: string,
	reader: FolderReader = systemFolderReader,
	limits: { depth?: number; entries?: number } = {},
): Promise<FolderSnapshot> {
	const maxDepth = limits.depth ?? MAX_DEPTH
	const maxEntries = limits.entries ?? MAX_ENTRIES
	const found: FolderSnapshot = new Map()
	let seen = 0
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: Awaited<ReturnType<FolderReader['list']>>
		try {
			entries = await reader.list(dir)
		} catch {
			return
		}
		for (const entry of entries) {
			if (seen >= maxEntries) return
			seen += 1
			// A folder or file that starts with a dot is the tool's own (.git, caches, settings).
			if (entry.name.startsWith('.')) continue
			const path = join(dir, entry.name)
			if (entry.directory) {
				if (depth < maxDepth && !SKIPPED.has(entry.name)) await walk(path, depth + 1)
			} else if (entry.file && isMadeFileKind(entry.name)) {
				const stamp = await reader.stat(path)
				if (stamp) found.set(path, stamp)
			}
		}
	}
	await walk(root, 0)
	return found
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
