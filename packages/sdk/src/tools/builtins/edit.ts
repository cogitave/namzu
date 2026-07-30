import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z
	.object({
		path: z.string().describe('Path to the file to edit'),
		old_string: z
			.string()
			.optional()
			.describe('The exact string to find and replace. Must be unique in the file.'),
		oldStr: z
			.string()
			.optional()
			.describe(
				'Alias for old_string. Used by hosts that expose text replacement as oldStr/newStr.',
			),
		new_string: z
			.string()
			.optional()
			.describe(
				'The replacement string. Self-budget this payload under 12000 characters before calling.',
			),
		newStr: z
			.string()
			.optional()
			.describe(
				'Alias for new_string. Also used as inserted content when insertLine is provided. Self-budget this payload under 12000 characters before calling.',
			),
		insertLine: z
			.union([z.number().int().min(0), z.literal('end')])
			.optional()
			.describe(
				'Optional line insertion target. Pass a JSON integer to insert after that 1-indexed line, 0 to insert before the first line, or the exact string "end" to append. Headings, anchors, numeric strings, null, and empty strings are invalid.',
			),
		replace_all: z
			.boolean()
			.default(false)
			.describe('Replace all occurrences instead of just the first unique match'),
	})
	.refine((value) => typeof value.new_string === 'string' || typeof value.newStr === 'string', {
		message: 'Either new_string or newStr is required.',
	})
	.refine(
		(value) =>
			value.insertLine !== undefined ||
			typeof value.old_string === 'string' ||
			typeof value.oldStr === 'string',
		{ message: 'Either old_string/oldStr or insertLine is required.' },
	)

type EditInput = z.infer<typeof inputSchema>

const modelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		path: {
			type: 'string',
			description: 'Path to the file to edit.',
		},
		old_string: {
			type: 'string',
			description: 'The exact unique string to find and replace.',
		},
		new_string: {
			type: 'string',
			description: 'The replacement or inserted text. Keep this payload under 12000 characters.',
		},
		insertLine: {
			anyOf: [{ type: 'integer' }, { type: 'string', const: 'end' }],
			description:
				'Line insertion target: a non-negative JSON integer, or the exact JSON string "end" to append.',
		},
		replace_all: {
			type: 'boolean',
			description: 'Replace every occurrence of old_string instead of one unique match.',
		},
	},
	required: ['path', 'new_string'],
	additionalProperties: false,
	anyOf: [
		{
			type: 'object',
			properties: {
				path: { type: 'string' },
				old_string: { type: 'string' },
				new_string: { type: 'string' },
				replace_all: { type: 'boolean' },
			},
			required: ['path', 'old_string', 'new_string'],
			additionalProperties: false,
		},
		{
			type: 'object',
			properties: {
				path: { type: 'string' },
				insertLine: {
					anyOf: [{ type: 'integer' }, { type: 'string', const: 'end' }],
				},
				new_string: { type: 'string' },
			},
			required: ['path', 'insertLine', 'new_string'],
			additionalProperties: false,
		},
	],
}

type NormalizedEditInput =
	| {
			operation: 'replace'
			oldString: string
			newString: string
			replace_all: boolean
	  }
	| {
			operation: 'insert'
			insertLine: number | 'end'
			newString: string
			replace_all: boolean
	  }

export const EditTool = defineTool({
	name: 'edit',
	description:
		'Makes targeted edits to a file using exact string find-and-replace or line insertion. THIS IS THE PREFERRED WAY TO MODIFY AN EXISTING FILE — never reach for `write` to change a file that already exists, because `write` overwrites the whole body and discards earlier work on partial failure. `edit` keeps the rest of the file byte-for-byte intact and is recoverable: if a single exact match fails or broader restructuring is needed, follow up with another `edit` instead of re-emitting the entire file via `write`. For replacement, pass path + old_string + new_string; old_string must be unique unless replace_all is true. For insertion, pass path + insertLine + new_string; use the parsed JSON value insertLine: "end" to append, never a string containing quote characters. Self-budget new_string under 12000 characters before emitting the tool call; use repeated bounded edits for long sections. Preserves file formatting and indentation.',
	inputSchema,
	modelInputSchema,
	enforceModelInput: true,
	validationErrorHint:
		'Accepted shapes: {"path":"file.md","insertLine":"end","new_string":"text"} or {"path":"file.md","old_string":"old","new_string":"new"}. Always include path; insertLine accepts only a non-negative JSON integer or the exact string "end".',
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,

	async execute(input: EditInput, context) {
		const normalized = normalizeEditInput(input)
		if (!normalized.success) {
			return { success: false, output: '', error: normalized.error }
		}
		if (
			normalized.operation.operation === 'replace' &&
			normalized.operation.oldString === normalized.operation.newString
		) {
			return {
				success: false,
				output: '',
				error: 'old_string/oldStr and new_string/newStr are identical — no change needed',
			}
		}

		// Sandbox-aware: route through sandbox when available
		if (context.sandbox) {
			const buffer = await context.sandbox.readFile(input.path)
			const content = buffer.toString('utf-8')

			const result = applyEdit(content, normalized.operation)
			if (!result.success) {
				return { success: false, output: '', error: result.error }
			}

			await context.sandbox.writeFile(input.path, result.content)
			return {
				success: true,
				output: `Edited ${input.path}: ${result.replacements} replacement(s) [sandboxed]`,
				data: {
					path: input.path,
					replacements: result.replacements,
					sandboxed: true,
				},
			}
		}

		const filePath = resolve(context.workingDirectory, input.path)
		const content = await readFile(filePath, 'utf-8')

		const result = applyEdit(content, normalized.operation)
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

function normalizeEditInput(
	input: EditInput,
): { success: true; operation: NormalizedEditInput } | { success: false; error: string } {
	const newString = input.new_string ?? input.newStr
	if (typeof newString !== 'string') {
		return {
			success: false,
			error: 'Either new_string or newStr is required.',
		}
	}

	if (input.insertLine !== undefined) {
		const insertLine = normalizeInsertLine(input.insertLine)
		if (!insertLine.success) return insertLine
		return {
			success: true,
			operation: {
				operation: 'insert',
				insertLine: insertLine.value,
				newString,
				replace_all: input.replace_all,
			},
		}
	}

	const oldString = input.old_string ?? input.oldStr
	if (typeof oldString !== 'string') {
		return {
			success: false,
			error: 'Either old_string/oldStr or insertLine is required.',
		}
	}
	return {
		success: true,
		operation: {
			operation: 'replace',
			oldString,
			newString,
			replace_all: input.replace_all,
		},
	}
}

function normalizeInsertLine(
	value: unknown,
): { success: true; value: number | 'end' } | { success: false; error: string } {
	if (value === 'end') return { success: true, value: 'end' }
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
		return { success: true, value }
	}
	return {
		success: false,
		error: 'insertLine must be a non-negative line number or "end".',
	}
}

function applyEdit(
	content: string,
	input: NormalizedEditInput,
): { success: true; content: string; replacements: number } | { success: false; error: string } {
	if (input.operation === 'insert') {
		return applyLineInsert(content, input)
	}

	if (!content.includes(input.oldString)) {
		return {
			success: false,
			error:
				'old_string/oldStr not found in file. Make sure the string matches exactly, including whitespace and indentation.',
		}
	}

	if (input.replace_all) {
		const parts = content.split(input.oldString)
		const replacements = parts.length - 1
		return {
			success: true,
			content: parts.join(input.newString),
			replacements,
		}
	}

	// Uniqueness check: old_string/oldStr must appear exactly once
	const firstIndex = content.indexOf(input.oldString)
	const secondIndex = content.indexOf(input.oldString, firstIndex + 1)

	if (secondIndex !== -1) {
		const lineNumber = content.slice(0, firstIndex).split('\n').length
		const secondLine = content.slice(0, secondIndex).split('\n').length
		return {
			success: false,
			error: `old_string/oldStr is not unique — found at lines ${lineNumber} and ${secondLine}. Provide more surrounding context to make it unique, or use replace_all: true.`,
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

function applyLineInsert(
	content: string,
	input: Extract<NormalizedEditInput, { operation: 'insert' }>,
): { success: true; content: string; replacements: number } {
	const hasTrailingNewline = content.endsWith('\n')
	const lines = content.split('\n')
	if (hasTrailingNewline) lines.pop()

	const line =
		input.insertLine === 'end'
			? lines.length
			: Math.min(Math.max(input.insertLine, 0), lines.length)
	const inserted = input.newString.endsWith('\n')
		? input.newString.slice(0, -1).split('\n')
		: input.newString.split('\n')
	lines.splice(line, 0, ...inserted)
	return {
		success: true,
		content: `${lines.join('\n')}${hasTrailingNewline ? '\n' : ''}`,
		replacements: 1,
	}
}
