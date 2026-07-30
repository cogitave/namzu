import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { atomicWriteFile } from './atomic-write-file.js'
import { withFileMutationLock } from './file-mutation-lock.js'

const inputSchema = z
	.object({
		path: z
			.string()
			.refine((value) => value.trim().length > 0, 'Path must not be empty.')
			.describe(
				'Relative path to the file to write (e.g. "outputs/report.md"). Must not be empty.',
			),
		content: z
			.string()
			.describe(
				'Complete bounded file body. Use "" only for an intentionally empty file. Keep under 12000 characters. For longer documents, include a deterministic marker such as {{CHUNK_001}} and advance it with exact edit calls.',
			),
	})
	.strict()

type WriteInput = z.infer<typeof inputSchema>

const modelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		path: {
			type: 'string',
			description: 'Non-empty path to the file to write.',
		},
		content: {
			type: 'string',
			description: 'Complete bounded file body. May be empty only for an intentionally empty file.',
		},
	},
	required: ['path', 'content'],
	additionalProperties: false,
}

export const WriteFileTool = defineTool({
	name: 'write',
	description:
		'Writes a complete bounded file body. Pass exactly path + content. If the file exists, read it first; prefer edit for targeted changes. Self-budget content under 12000 characters. For longer documents, write an opening with a deterministic marker such as {{CHUNK_001}}, then use exact edit calls that advance the marker one chunk at a time. Do not chain write calls because each overwrites the file.',
	inputSchema,
	modelInputSchema,
	enforceModelInput: true,
	validationErrorHint: 'Required shape: {"path":"file.md","content":"complete bounded file body"}.',
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: true,
	concurrencySafe: false,

	async execute(input: WriteInput, context) {
		const parsed = inputSchema.safeParse(input)
		if (!parsed.success) {
			return {
				success: false,
				output: '',
				error: `Invalid write input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
			}
		}
		const canonicalInput = parsed.data

		const filePath = resolve(context.workingDirectory, canonicalInput.path)
		const lockKey = `${context.sandbox ? 'sandbox' : 'local'}:${filePath}`
		return withFileMutationLock(lockKey, async () => {
			if (context.sandbox) {
				const sandboxExists = await sandboxFileExists(context, canonicalInput.path)
				if (sandboxExists) {
					const guard = enforceReadBeforeOverwrite(context, canonicalInput.path)
					if (guard) return guard
				}
				await context.sandbox.writeFile(canonicalInput.path, canonicalInput.content)
				context.fileReadTracker?.recordRead(canonicalInput.path)
				return {
					success: true as const,
					output: `File written successfully: ${canonicalInput.path} (${canonicalInput.content.length} chars) [sandboxed]`,
					data: {
						path: canonicalInput.path,
						size: canonicalInput.content.length,
						sandboxed: true,
					},
				}
			}

			const localExists = await pathExists(filePath)
			if (localExists) {
				const guard = enforceReadBeforeOverwrite(context, filePath)
				if (guard) return guard
			}

			await atomicWriteFile(filePath, canonicalInput.content)
			context.fileReadTracker?.recordRead(filePath)
			return {
				success: true as const,
				output: `File written successfully: ${filePath} (${canonicalInput.content.length} chars)`,
				data: { path: filePath, size: canonicalInput.content.length },
			}
		})
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
