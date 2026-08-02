import { glob, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Sandbox } from '../../types/sandbox/index.js'
import { defineTool } from '../defineTool.js'
import { matchesGlob } from '../glob-match.js'
import { resolveWithin } from '../paths.js'
import { joinPosix, relativePosix, resolveWithinPosix } from '../posix-path.js'

/**
 * Where the files come from.
 *
 * The host and the sandbox differ in exactly two operations — enumerate
 * and read — so that is all this abstracts. Matching, context lines and
 * the caps stay in one implementation; duplicating them per source is how
 * the two would drift apart, and the sandbox path is the one nobody runs
 * by accident.
 */
interface FileSource {
	/** The root every reported path is relative to. */
	readonly root: string
	/** True when paths are the sandbox's, not the host's. */
	readonly posix?: boolean
	list(searchRoot: string, pattern: string): AsyncIterable<string>
	read(path: string): Promise<Buffer>
}

function hostSource(workingDirectory: string): FileSource {
	return {
		root: workingDirectory,
		async *list(searchRoot, pattern) {
			for await (const entry of glob(pattern, { cwd: searchRoot })) {
				yield resolve(searchRoot, entry)
			}
		},
		read: (path) => readFile(path),
	}
}

function sandboxSource(sandbox: Sandbox): FileSource {
	return {
		root: sandbox.rootDir,
		posix: true,
		async *list(searchRoot, pattern) {
			for (const entry of await sandbox.listFiles(searchRoot)) {
				// Sandbox paths stay in the sandbox's own coordinate system.
				// Running them through the host's path module would rewrite a
				// POSIX container path into a host-shaped one whenever the
				// two disagree, and then hand the model a path its own
				// sandbox cannot open.
				const absolute = joinPosix(searchRoot, entry.path)
				const relPath = relativePosix(sandbox.rootDir, absolute)
				if (matchesGlob(relPath, pattern)) yield absolute
			}
		},
		read: (path) => sandbox.readFile(path),
	}
}

const inputSchema = z.object({
	pattern: z.string().describe('Regular expression pattern to search for in file contents'),
	path: z
		.string()
		.optional()
		.describe('File or directory to search in. Defaults to the working directory.'),
	include: z
		.string()
		.optional()
		.describe('Glob pattern to filter files (e.g. "*.ts", "**/*.{js,jsx}")'),
	case_sensitive: z.boolean().default(true).describe('Whether the search is case-sensitive'),
	context_lines: z.coerce
		.number()
		.int()
		.min(0)
		.default(0)
		.describe('Number of lines to show before and after each match'),
	max_results: z.coerce
		.number()
		.int()
		.min(1)
		.default(100)
		.describe('Maximum number of matching lines to return'),
})

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB — skip binaries/large files
const BINARY_CHECK_BYTES = 512

function isBinaryContent(buffer: Buffer): boolean {
	const check = buffer.subarray(0, BINARY_CHECK_BYTES)
	for (const byte of check) {
		if (byte === 0) return true
	}
	return false
}

export const GrepTool = defineTool({
	name: 'grep',
	description:
		'Searches file contents using a regular expression. Returns matching lines with file paths, line numbers, and optional context lines. Skips binary files.',
	inputSchema,
	category: 'analysis',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		const flags = input.case_sensitive ? 'g' : 'gi'
		let regex: RegExp
		try {
			regex = new RegExp(input.pattern, flags)
		} catch (err) {
			return {
				success: false,
				output: '',
				error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
			}
		}

		// Inside the sandbox when there is one, on the host otherwise. Only
		// the file SOURCE differs — matching, context lines and the caps are
		// one implementation, because duplicating the substantive half is
		// how the two paths would drift.
		//
		// This tool read the host filesystem through `node:fs` and
		// referenced `context.sandbox` nowhere, so with a container backend
		// wired in the sandbox was not a read boundary at all — and grep
		// returns file CONTENT, so what leaked was not a listing.
		const source: FileSource = context.sandbox
			? sandboxSource(context.sandbox)
			: hostSource(context.workingDirectory)

		// Contained, not merely resolved — see `resolveWithin`. Bare
		// resolution let `path: "../../.."` read whatever sits above the
		// working directory, with no sandbox needed to make it work.
		const searchRoot = source.posix
			? resolveWithinPosix(source.root, input.path)
			: resolveWithin(source.root, input.path)

		// Auto-prepend **/ for simple patterns (e.g. "*.ts" → "**/*.ts")
		let filePattern = input.include ?? '**/*'
		if (filePattern !== '**/*' && !filePattern.includes('/') && !filePattern.startsWith('**/')) {
			filePattern = `**/${filePattern}`
		}

		const results: string[] = []
		let totalMatches = 0
		let filesSearched = 0
		let filesMatched = 0

		for await (const filePath of source.list(searchRoot, filePattern)) {
			filesSearched++

			let content: string
			try {
				const buffer = await source.read(filePath)
				if (buffer.length > MAX_FILE_SIZE) continue
				if (isBinaryContent(buffer)) continue
				content = buffer.toString('utf-8')
			} catch {
				continue // Skip unreadable files (directories, permissions, etc.)
			}

			const lines = content.split('\n')
			let fileHasMatch = false

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? ''
				regex.lastIndex = 0
				if (!regex.test(line)) continue

				if (!fileHasMatch) {
					fileHasMatch = true
					filesMatched++
				}

				// Relative to the root the file came FROM. Reporting a
				// host-relative path for a file read inside the sandbox would
				// hand the model a string `read` then resolves somewhere else.
				const relPath = source.posix
					? `./${relativePosix(source.root, filePath)}`
					: `./${relative(source.root, filePath).split(sep).join('/')}`

				if (input.context_lines > 0) {
					const start = Math.max(0, i - input.context_lines)
					const end = Math.min(lines.length - 1, i + input.context_lines)

					if (results.length > 0) {
						results.push('--')
					}

					for (let j = start; j <= end; j++) {
						const prefix = j === i ? ':' : '-'
						results.push(`${relPath}${prefix}${j + 1}${prefix}${lines[j]}`)
					}
				} else {
					results.push(`${relPath}:${i + 1}:${line}`)
				}

				totalMatches++
				if (totalMatches >= input.max_results) break
			}

			if (totalMatches >= input.max_results) break
		}

		if (totalMatches === 0) {
			return {
				success: true,
				output: `No matches found for pattern "${input.pattern}"`,
				data: { totalMatches: 0, filesSearched, filesMatched: 0 },
			}
		}

		const summary = `Found ${totalMatches} match(es) in ${filesMatched} file(s) (${filesSearched} files searched)`
		const output = `${results.join('\n')}\n\n${summary}`

		return {
			success: true,
			output,
			data: { totalMatches, filesSearched, filesMatched },
		}
	},
})
