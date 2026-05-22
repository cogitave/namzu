import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	path: z.string().describe('Path to the file to read (absolute or relative)'),
	readRange: z
		.tuple([z.coerce.number().int().min(1), z.coerce.number().int().min(1)])
		.optional()
		.describe(
			'Optional 1-indexed inclusive line range, e.g. [10, 40]. When provided it takes precedence over offset/limit.',
		),
	offset: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Starting line number (0-indexed). Defaults to 0 (beginning of file).'),
	limit: z.coerce.number().optional().describe('Maximum number of lines to read'),
})

export const ReadFileTool = defineTool({
	name: 'read',
	description:
		'Reads a file and returns its contents with line numbers. Supports readRange ([start,end], 1-indexed inclusive) or offset/limit for large files.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		// Sandbox-aware: route through sandbox.readFile() when available
		if (context.sandbox) {
			const buffer = await context.sandbox.readFile(input.path)
			const content = buffer.toString('utf-8')
			const lines = content.split('\n')

			const { start, end } = resolveReadWindow(input, lines.length)
			const selectedLines = lines.slice(start, end)

			const numberedLines = selectedLines.map((line, i) => `${start + i + 1}\t${line}`).join('\n')

			context.fileReadTracker?.recordRead(input.path)

			return {
				success: true,
				output: numberedLines,
				data: {
					totalLines: lines.length,
					returnedLines: selectedLines.length,
					path: input.path,
					sandboxed: true,
				},
			}
		}

		const filePath = resolve(context.workingDirectory, input.path)
		const content = await readFile(filePath, 'utf-8')
		const lines = content.split('\n')

		const { start, end } = resolveReadWindow(input, lines.length)
		const selectedLines = lines.slice(start, end)

		const numberedLines = selectedLines.map((line, i) => `${start + i + 1}\t${line}`).join('\n')

		context.fileReadTracker?.recordRead(filePath)

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

function resolveReadWindow(
	input: z.infer<typeof inputSchema>,
	totalLines: number,
): { start: number; end: number } {
	if (input.readRange) {
		const [first, last] = input.readRange
		const start = Math.max(0, first - 1)
		const end = Math.min(totalLines, Math.max(start, last))
		return { start, end }
	}
	const start = Math.max(0, input.offset ?? 0)
	const end = input.limit ? start + input.limit : totalLines
	return { start, end }
}
