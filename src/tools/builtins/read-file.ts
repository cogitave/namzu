import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	path: z.string().describe('Path to the file to read (absolute or relative)'),
	offset: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Starting line number (0-indexed). Defaults to 0 (beginning of file).'),
	limit: z.coerce.number().optional().describe('Maximum number of lines to read'),
})

export const ReadFileTool = defineTool({
	name: 'read_file',
	description:
		'Reads a file and returns its contents with line numbers. Supports offset and limit parameters for large files.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		const filePath = resolve(context.workingDirectory, input.path)
		const content = await readFile(filePath, 'utf-8')
		const lines = content.split('\n')

		const start = Math.max(0, input.offset ?? 0)
		const end = input.limit ? start + input.limit : lines.length
		const selectedLines = lines.slice(start, end)

		const numberedLines = selectedLines.map((line, i) => `${start + i}\t${line}`).join('\n')

		return {
			success: true,
			output: numberedLines,
			data: {
				totalLines: lines.length,
				returnedLines: selectedLines.length,
				path: filePath,
			},
		}
	},
})
