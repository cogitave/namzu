import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Relative path to the file to append to (e.g. "scratch/report.md"). Required. Must be a non-empty string. The file is created if it does not exist.',
		),
	content: z
		.string()
		.describe(
			'Text to append to the file. The content is written verbatim — include a leading newline if you want a paragraph break before this chunk.',
		),
})

export const AppendFileTool = defineTool({
	name: 'append',
	description:
		'Append text to a file (creating it if it does not exist). Use this when a single `write` call would risk hitting the model output token limit mid-stream — write the opening section with `write`, then call `append` repeatedly to extend the file section by section. Each `append` call resets the per-call output budget, so a 20k-word document is just a handful of `append` calls in a loop. The file is never overwritten; content is added at the end. For modifying existing text inside a file, use `edit` instead.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	// Constructive: appends do not destroy prior content. The
	// read-before-overwrite invariant does NOT apply to append.
	destructive: false,
	concurrencySafe: false,

	async execute(input, context) {
		if (context.sandbox) {
			// Sandbox path: read existing content (if any), concatenate,
			// write back. The Sandbox interface does not expose an append
			// primitive, so we do it client-side. This costs one extra
			// read per append but keeps the SDK contract uniform across
			// backends.
			let existing = ''
			try {
				const buffer = await context.sandbox.readFile(input.path)
				existing = buffer.toString('utf-8')
			} catch {
				// File doesn't exist yet — that's fine, we're creating it.
			}
			const next = existing + input.content
			await context.sandbox.writeFile(input.path, next)
			context.fileReadTracker?.recordRead(input.path)
			return {
				success: true,
				output: `Appended ${input.content.length} chars to ${input.path} (new size ${next.length}) [sandboxed]`,
				data: {
					path: input.path,
					appended: input.content.length,
					size: next.length,
					sandboxed: true,
				},
			}
		}

		const filePath = resolve(context.workingDirectory, input.path)
		await mkdir(dirname(filePath), { recursive: true })
		await appendFile(filePath, input.content, 'utf-8')
		context.fileReadTracker?.recordRead(filePath)
		return {
			success: true,
			output: `Appended ${input.content.length} chars to ${filePath}`,
			data: { path: filePath, appended: input.content.length },
		}
	},
})
