import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { Sandbox } from '../../types/sandbox/index.js'
import type { ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithin } from '../paths.js'
import { joinPosix, relativePosix, resolveWithinPosix } from '../posix-path.js'

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

/**
 * Enumerate inside the sandbox.
 *
 * This tool read the HOST filesystem through `node:fs` and referenced
 * `context.sandbox` nowhere, so with a container or microVM backend wired in
 * it enumerated the host — in the one builtin whose entire job is telling the
 * model what exists. `glob` carried the identical defect, was fixed, and its
 * fix notes that "every sibling builtin already remembers this branch". This
 * was the sibling that did not, which is why the claim needed checking rather
 * than reading.
 *
 * Worse than a leak on its own: the paths it returned were host-relative,
 * while `read`, `grep` and `glob` all resolve INSIDE the sandbox. So every
 * ls-to-read handoff either failed or opened a different file than the one
 * listed. This returns the sandbox-relative coordinates the others speak.
 *
 * `listFiles` reports files, not directories — every backend implements it as
 * a recursive file walk — so directories are derived from the paths. A
 * directory holding nothing is therefore invisible here, which is a real
 * difference from the host branch and the honest cost of having one
 * enumeration primitive rather than one per backend.
 */
async function listInSandbox(
	input: { path: string; all: boolean; recursive: boolean; max_depth: number },
	sandbox: Sandbox,
): Promise<ToolResult> {
	const root = resolveWithinPosix(sandbox.rootDir, input.path)
	const entries = await sandbox.listFiles(root)

	// Relative to the LISTED directory, in the sandbox's own coordinates.
	const relativePaths: { segments: string[]; size: number }[] = []
	for (const entry of entries) {
		const rel = relativePosix(root, joinPosix(root, entry.path))
		if (!rel || rel.startsWith('..')) continue
		const segments = rel.split('/').filter(Boolean)
		if (segments.length === 0) continue
		if (!input.all && segments.some((s) => s.startsWith('.'))) continue
		relativePaths.push({ segments, size: entry.size })
	}

	if (!input.recursive) {
		// One level: a single segment is a file, more than one means the
		// first segment is a directory.
		const files = new Map<string, number>()
		const dirs = new Set<string>()
		for (const { segments, size } of relativePaths) {
			const head = segments[0] as string
			if (segments.length === 1) files.set(head, size)
			else dirs.add(head)
		}

		const lines = [
			...[...dirs].sort().map((name) => `${name}/`),
			...[...files.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, size]) => `${name}\t${formatSize(size)}`),
		]

		return {
			success: true,
			output: lines.length > 0 ? lines.join('\n') : '(empty directory)',
			data: { count: lines.length, sandboxed: true },
		}
	}

	const seenDirs = new Set<string>()
	const lines: string[] = []
	let count = 0
	for (const { segments, size } of relativePaths.sort((a, b) =>
		a.segments.join('/').localeCompare(b.segments.join('/')),
	)) {
		if (segments.length > input.max_depth) continue
		// Emit each parent directory once, before anything inside it.
		for (let depth = 1; depth < segments.length; depth++) {
			const dir = segments.slice(0, depth).join('/')
			if (seenDirs.has(dir)) continue
			seenDirs.add(dir)
			if (count >= MAX_ENTRIES) break
			lines.push(`./${dir}/`)
			count++
		}
		if (count >= MAX_ENTRIES) break
		lines.push(`./${segments.join('/')} (${formatSize(size)})`)
		count++
	}

	const truncated = count >= MAX_ENTRIES ? `\n(truncated at ${MAX_ENTRIES} entries)` : ''

	return {
		success: true,
		output: lines.length > 0 ? lines.join('\n') + truncated : '(empty directory)',
		data: { count, truncated: count >= MAX_ENTRIES, sandboxed: true },
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
		if (context.sandbox) {
			return await listInSandbox(input, context.sandbox)
		}

		// Contained, not merely resolved — see `resolveWithin`.
		const targetPath = resolveWithin(context.workingDirectory, input.path)

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
