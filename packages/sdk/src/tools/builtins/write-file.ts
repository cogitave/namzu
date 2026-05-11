import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../../types/tool/index.js'
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
			'Full file body to write. Required (use "" only for an intentionally empty file). The file is fully overwritten — pass the COMPLETE intended content, not a diff. If the intended body risks being cut off by the per-call output token limit, write a smaller opening section here, then use `edit` to extend the file section by section; do NOT try to chain multiple `write` calls, since each one overwrites the previous.',
		),
})

export const WriteFileTool = defineTool({
	name: 'write',
	description:
		'Writes a file to the local filesystem. Overwrites the existing file at the path if there is one.\n\n- If the file already exists, you must use the `read` tool on it first in this conversation, or this call will fail.\n- Prefer the `edit` tool for modifying existing files — it only sends the diff and preserves the rest of the file byte-for-byte.\n- Use `write` to create a new file or to perform a deliberate full rewrite of a file you have already read.\n- For long content, write a smaller opening section, then use `edit` to extend the file section by section. Do not chain multiple `write` calls — each one overwrites the previous.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: true,
	concurrencySafe: false,

	async execute(input, context) {
		// Sandbox-aware: route through sandbox.writeFile() when available
		if (context.sandbox) {
			const sandboxExists = await sandboxFileExists(context, input.path)
			if (sandboxExists) {
				const guard = enforceReadBeforeOverwrite(context, input.path)
				if (guard) return guard
			}
			await context.sandbox.writeFile(input.path, input.content)
			context.fileReadTracker?.recordRead(input.path)
			return {
				success: true,
				output: `File written successfully: ${input.path} (${input.content.length} chars) [sandboxed]`,
				data: { path: input.path, size: input.content.length, sandboxed: true },
			}
		}

		const filePath = resolve(context.workingDirectory, input.path)

		const localExists = await pathExists(filePath)
		if (localExists) {
			const guard = enforceReadBeforeOverwrite(context, filePath)
			if (guard) return guard
		}

		await mkdir(dirname(filePath), { recursive: true })
		await writeFile(filePath, input.content, 'utf-8')
		context.fileReadTracker?.recordRead(filePath)

		return {
			success: true,
			output: `File written successfully: ${filePath} (${input.content.length} chars)`,
			data: { path: filePath, size: input.content.length },
		}
	},
})

function enforceReadBeforeOverwrite(
	context: ToolContext,
	key: string,
): { success: false; output: ''; error: string } | null {
	if (!context.fileReadTracker) return null
	if (context.fileReadTracker.hasRead(key)) return null
	return {
		success: false,
		output: '',
		error: `${key} already exists. Use the \`read\` tool on it first in this conversation, then call \`write\` again — or prefer \`edit\` for a targeted change.`,
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

async function sandboxFileExists(context: ToolContext, path: string): Promise<boolean> {
	if (!context.sandbox) return false
	try {
		await context.sandbox.readFile(path)
		return true
	} catch {
		return false
	}
}
