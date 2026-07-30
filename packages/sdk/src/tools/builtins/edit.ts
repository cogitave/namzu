import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'
import { atomicWriteFile } from './atomic-write-file.js'
import { withFileMutationLock } from './file-mutation-lock.js'

const inputSchema = z
	.object({
		path: z
			.string()
			.refine((value) => value.trim().length > 0, 'Path must not be empty.')
			.describe('Path to the file to edit. Must not be empty.'),
		old_string: z
			.string()
			.min(1)
			.describe(
				'The exact unique text to replace, without read-tool line-number prefixes. Must not be empty.',
			),
		new_string: z
			.string()
			.describe(
				'The exact replacement text. May be empty to delete old_string. Keep this payload under 12000 characters.',
			),
		replace_all: z
			.boolean()
			.default(false)
			.describe('Replace every occurrence instead of requiring one unique match.'),
	})
	.strict()

type EditInput = z.infer<typeof inputSchema>

const modelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		path: {
			type: 'string',
			description: 'Path to the file to edit. Must not be empty.',
		},
		old_string: {
			type: 'string',
			description:
				'Exact unique text from the file, without read-tool line-number prefixes. Must not be empty.',
		},
		new_string: {
			type: 'string',
			description:
				'Exact replacement text. May be empty to delete old_string. Keep under 12000 characters.',
		},
		replace_all: {
			type: 'boolean',
			description: 'Replace every occurrence instead of requiring one unique match.',
		},
	},
	required: ['path', 'old_string', 'new_string'],
	additionalProperties: false,
}

type ExactReplacement = Readonly<{
	oldString: string
	newString: string
	replaceAll: boolean
}>

export const EditTool = defineTool({
	name: 'edit',
	description:
		"Performs one targeted exact-string replacement in an existing file. Pass path + old_string + new_string; old_string must match exactly and be unique unless replace_all is true. Read the file immediately before editing, preserve whitespace and indentation, and never include the read tool's line-number prefix in old_string. To append or insert, replace a unique existing tail/marker with itself plus the new text; advance a deterministic marker such as {{CHUNK_001}} to {{CHUNK_002}} so replaying a completed edit cannot duplicate content. Prefer this tool over rewriting an existing file. Self-budget new_string under 12000 characters.",
	inputSchema,
	modelInputSchema,
	enforceModelInput: true,
	validationErrorHint:
		'Required shape: {"path":"file.md","old_string":"exact unique text","new_string":"replacement text"}. Optional: "replace_all": true.',
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,

	async execute(input: EditInput, context) {
		const parsed = inputSchema.safeParse(input)
		if (!parsed.success) {
			return {
				success: false,
				output: '',
				error: `Invalid edit input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
			}
		}
		const canonicalInput = parsed.data

		const replacement: ExactReplacement = {
			oldString: canonicalInput.old_string,
			newString: canonicalInput.new_string,
			replaceAll: canonicalInput.replace_all,
		}
		if (replacement.oldString === replacement.newString) {
			return {
				success: false,
				output: '',
				error: 'old_string and new_string are identical — no change needed.',
			}
		}

		const filePath = resolve(context.workingDirectory, canonicalInput.path)
		const lockKey = `${context.sandbox ? 'sandbox' : 'local'}:${filePath}`

		return withFileMutationLock(lockKey, async () => {
			if (context.sandbox) {
				const buffer = await context.sandbox.readFile(canonicalInput.path)
				const result = applyEdit(buffer.toString('utf-8'), replacement)
				if (!result.success) return { success: false as const, output: '', error: result.error }

				await context.sandbox.writeFile(canonicalInput.path, result.content)
				return {
					success: true as const,
					output: `Edited ${canonicalInput.path}: ${result.replacements} replacement(s) [sandboxed]`,
					data: {
						path: canonicalInput.path,
						replacements: result.replacements,
						sandboxed: true,
					},
				}
			}

			const content = await readFile(filePath, 'utf-8')
			const result = applyEdit(content, replacement)
			if (!result.success) return { success: false as const, output: '', error: result.error }

			await atomicWriteFile(filePath, result.content)
			return {
				success: true as const,
				output: `Edited ${filePath}: ${result.replacements} replacement(s)`,
				data: { path: filePath, replacements: result.replacements },
			}
		})
	},
})

function normalizeLineEndings(content: string, input: ExactReplacement): ExactReplacement {
	const withoutCrlf = content.replaceAll('\r\n', '')
	const usesOnlyCrlf = content.includes('\r\n') && !withoutCrlf.includes('\n')
	if (usesOnlyCrlf) {
		return {
			...input,
			oldString: content.includes(input.oldString)
				? input.oldString
				: input.oldString.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'),
			newString: input.newString.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'),
		}
	}

	const usesOnlyLf = content.includes('\n') && !content.includes('\r\n')
	if (usesOnlyLf) {
		return {
			...input,
			oldString: content.includes(input.oldString)
				? input.oldString
				: input.oldString.replaceAll('\r\n', '\n'),
			newString: input.newString.replaceAll('\r\n', '\n'),
		}
	}
	return input
}

function applyEdit(
	content: string,
	rawInput: ExactReplacement,
): { success: true; content: string; replacements: number } | { success: false; error: string } {
	const input = normalizeLineEndings(content, rawInput)
	if (!content.includes(input.oldString)) {
		return {
			success: false,
			error:
				'old_string was not found. Read the file again and copy exact text without line-number prefixes.',
		}
	}

	if (input.replaceAll) {
		const parts = content.split(input.oldString)
		return {
			success: true,
			content: parts.join(input.newString),
			replacements: parts.length - 1,
		}
	}

	const firstIndex = content.indexOf(input.oldString)
	const secondIndex = content.indexOf(input.oldString, firstIndex + input.oldString.length)
	if (secondIndex !== -1) {
		const firstLine = content.slice(0, firstIndex).split('\n').length
		const secondLine = content.slice(0, secondIndex).split('\n').length
		return {
			success: false,
			error: `old_string is not unique — found at lines ${firstLine} and ${secondLine}. Include more surrounding context, or use replace_all: true.`,
		}
	}

	return {
		success: true,
		content:
			content.slice(0, firstIndex) +
			input.newString +
			content.slice(firstIndex + input.oldString.length),
		replacements: 1,
	}
}
