import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	path: z.string().default('.').describe('Directory path to list. Defaults to working directory.'),
	all: z.boolean().default(false).describe('Include hidden files (dotfiles)'),
	recursive: z.boolean().default(false).describe('List directories recursively'),
	max_depth: z.coerce
		.number()
		.int()
		.min(1)
		.default(3)
		.describe('Maximum depth for recursive listing. Default: 3'),
})

const MAX_ENTRIES = 1000

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`
}

interface ListEntry {
	name: string
	type: 'file' | 'dir' | 'symlink' | 'other'
	size: number
}

async function listDirectory(dirPath: string, showHidden: boolean): Promise<ListEntry[]> {
	const entries = await readdir(dirPath, { withFileTypes: true })
	const results: ListEntry[] = []

	for (const entry of entries) {
		if (!showHidden && entry.name.startsWith('.')) continue

		let type: ListEntry['type'] = 'other'
		let size = 0

		if (entry.isDirectory()) {
			type = 'dir'
		} else if (entry.isSymbolicLink()) {
			type = 'symlink'
		} else if (entry.isFile()) {
			type = 'file'
			try {
				const s = await stat(join(dirPath, entry.name))
				size = s.size
			} catch {
				// stat may fail for broken symlinks
			}
		}

		results.push({ name: entry.name, type, size })
	}

	// Sort: directories first, then alphabetical
	results.sort((a, b) => {
		if (a.type === 'dir' && b.type !== 'dir') return -1
		if (a.type !== 'dir' && b.type === 'dir') return 1
		return a.name.localeCompare(b.name)
	})

	return results
}

async function listRecursive(
	basePath: string,
	currentPath: string,
	showHidden: boolean,
	maxDepth: number,
	depth: number,
	output: string[],
	count: { value: number },
): Promise<void> {
	if (depth > maxDepth || count.value >= MAX_ENTRIES) return

	const entries = await listDirectory(currentPath, showHidden)

	for (const entry of entries) {
		if (count.value >= MAX_ENTRIES) break

		const relPath = `./${relative(basePath, join(currentPath, entry.name))}`
		const suffix = entry.type === 'dir' ? '/' : ''
		const sizeStr = entry.type === 'file' ? ` (${formatSize(entry.size)})` : ''

		output.push(`${relPath}${suffix}${sizeStr}`)
		count.value++

		if (entry.type === 'dir') {
			await listRecursive(
				basePath,
				join(currentPath, entry.name),
				showHidden,
				maxDepth,
				depth + 1,
				output,
				count,
			)
		}
	}
}

export const LsTool = defineTool({
	name: 'ls',
	description:
		'Lists directory contents. Shows files and directories with sizes. Supports recursive listing with depth limit, and hidden file display.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		const targetPath = resolve(context.workingDirectory, input.path)

		if (input.recursive) {
			const output: string[] = []
			const count = { value: 0 }
			await listRecursive(
				context.workingDirectory,
				targetPath,
				input.all,
				input.max_depth,
				1,
				output,
				count,
			)

			const truncated = count.value >= MAX_ENTRIES ? `\n(truncated at ${MAX_ENTRIES} entries)` : ''

			return {
				success: true,
				output: output.length > 0 ? output.join('\n') + truncated : '(empty directory)',
				data: { count: count.value, truncated: count.value >= MAX_ENTRIES },
			}
		}

		const entries = await listDirectory(targetPath, input.all)
		const lines = entries.map((e) => {
			const suffix = e.type === 'dir' ? '/' : e.type === 'symlink' ? ' →' : ''
			const sizeStr = e.type === 'file' ? `\t${formatSize(e.size)}` : ''
			return `${e.name}${suffix}${sizeStr}`
		})

		return {
			success: true,
			output: lines.length > 0 ? lines.join('\n') : '(empty directory)',
			data: { count: entries.length },
		}
	},
})
