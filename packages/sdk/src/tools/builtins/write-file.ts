import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	path: z.string().describe('Path to the file to write'),
	content: z.string().describe('Content to write to the file'),
})

export const WriteFileTool = defineTool({
	name: 'Write',
	description:
		'Writes content to a file. Creates the file if it does not exist, overwrites if it does. Creates intermediate directories as needed.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: true,
	concurrencySafe: false,

	async execute(input, context) {
		// Sandbox-aware: route through sandbox.writeFile() when available
		if (context.sandbox) {
			await context.sandbox.writeFile(input.path, input.content)
			return {
				success: true,
				output: `File written successfully: ${input.path} (${input.content.length} chars) [sandboxed]`,
				data: { path: input.path, size: input.content.length, sandboxed: true },
			}
		}

		const filePath = resolve(context.workingDirectory, input.path)

		await mkdir(dirname(filePath), { recursive: true })
		await writeFile(filePath, input.content, 'utf-8')

		return {
			success: true,
			output: `File written successfully: ${filePath} (${input.content.length} chars)`,
			data: { path: filePath, size: input.content.length },
		}
	},
})
