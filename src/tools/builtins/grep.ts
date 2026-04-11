import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

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

		const searchRoot = input.path
			? resolve(context.workingDirectory, input.path)
			: context.workingDirectory

		// Auto-prepend **/ for simple patterns (e.g. "*.ts" → "**/*.ts")
		let filePattern = input.include ?? '**/*'
		if (filePattern !== '**/*' && !filePattern.includes('/') && !filePattern.startsWith('**/')) {
			filePattern = `**/${filePattern}`
		}

		const results: string[] = []
		let totalMatches = 0
		let filesSearched = 0
		let filesMatched = 0

		for await (const entry of glob(filePattern, { cwd: searchRoot })) {
			const filePath = resolve(searchRoot, entry)
			filesSearched++

			let content: string
			try {
				const buffer = await readFile(filePath)
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

				const relPath = `./${relative(context.workingDirectory, filePath)}`

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
