import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Relative path to the file to write (e.g. "outputs/report.md"). Required. Must be a non-empty string.',
		),
	content: z
		.string()
		.describe(
			'Full file body to write. Required (use "" only for an intentionally empty file). The file is fully overwritten — pass the COMPLETE intended content, not a diff. If the body is large enough to risk hitting the model output token limit mid-call, split into multiple smaller writes (e.g. write the header first, then call again to append a section).',
		),
})

export const WriteFileTool = defineTool({
	name: 'Write',
	description:
		'Writes content to a file. Creates the file if it does not exist, overwrites if it does. Creates intermediate directories as needed. Both `path` and `content` are required — never call this tool with empty arguments. For long content, prefer multiple smaller writes over one large write so the call cannot be cut off by an output token limit.',
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
