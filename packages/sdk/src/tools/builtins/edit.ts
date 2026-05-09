import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	path: z.string().describe('Path to the file to edit'),
	old_string: z
		.string()
		.describe('The exact string to find and replace. Must be unique in the file.'),
	new_string: z.string().describe('The replacement string'),
	replace_all: z
		.boolean()
		.default(false)
		.describe('Replace all occurrences instead of just the first unique match'),
})

type EditInput = z.infer<typeof inputSchema>

export const EditTool = defineTool({
	name: 'edit',
	description:
		'Makes targeted edits to a file using exact string find-and-replace. The old_string must be unique in the file unless replace_all is true. Preserves file formatting and indentation.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,

	async execute(input: EditInput, context) {
		if (input.old_string === input.new_string) {
			return {
				success: false,
				output: '',
				error: 'old_string and new_string are identical — no change needed',
			}
		}

		// Sandbox-aware: route through sandbox when available
		if (context.sandbox) {
			const buffer = await context.sandbox.readFile(input.path)
			const content = buffer.toString('utf-8')

			const result = applyEdit(content, input)
			if (!result.success) {
				return { success: false, output: '', error: result.error }
			}

			await context.sandbox.writeFile(input.path, result.content)
			return {
				success: true,
				output: `Edited ${input.path}: ${result.replacements} replacement(s) [sandboxed]`,
				data: { path: input.path, replacements: result.replacements, sandboxed: true },
			}
		}

		const filePath = resolve(context.workingDirectory, input.path)
		const content = await readFile(filePath, 'utf-8')

		const result = applyEdit(content, input)
		if (!result.success) {
			return { success: false, output: '', error: result.error }
		}

		await writeFile(filePath, result.content, 'utf-8')
		return {
			success: true,
			output: `Edited ${filePath}: ${result.replacements} replacement(s)`,
			data: { path: filePath, replacements: result.replacements },
		}
	},
})

function applyEdit(
	content: string,
	input: EditInput,
): { success: true; content: string; replacements: number } | { success: false; error: string } {
	if (!content.includes(input.old_string)) {
		return {
			success: false,
			error:
				'old_string not found in file. Make sure the string matches exactly, including whitespace and indentation.',
		}
	}

	if (input.replace_all) {
		const parts = content.split(input.old_string)
		const replacements = parts.length - 1
		return {
			success: true,
			content: parts.join(input.new_string),
			replacements,
		}
	}

	// Uniqueness check: old_string must appear exactly once
	const firstIndex = content.indexOf(input.old_string)
	const secondIndex = content.indexOf(input.old_string, firstIndex + 1)

	if (secondIndex !== -1) {
		const lineNumber = content.slice(0, firstIndex).split('\n').length
		const secondLine = content.slice(0, secondIndex).split('\n').length
		return {
			success: false,
			error: `old_string is not unique — found at lines ${lineNumber} and ${secondLine}. Provide more surrounding context to make it unique, or use replace_all: true.`,
		}
	}

	return {
		success: true,
		content:
			content.slice(0, firstIndex) +
			input.new_string +
			content.slice(firstIndex + input.old_string.length),
		replacements: 1,
	}
}
