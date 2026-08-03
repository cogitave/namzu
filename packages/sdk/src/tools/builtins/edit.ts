import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'
import { atomicWriteFile } from './atomic-write-file.js'
import { withFileMutationLock } from './file-mutation-lock.js'

/**
 * Two schemas, on purpose.
 *
 * `inputSchema` is what a HOST may send, and it accepts the `oldStr`/`newStr`
 * aliases and `insertLine` because hosts that expose replacement under those
 * names are real. `modelInputSchema` below is what a MODEL is constrained to
 * — one closed canonical shape — because giving a model four spellings of the
 * same field is how it learns to guess between them.
 *
 * `.strict()` is what makes the accepted set closed. Without it zod's default
 * is to STRIP an unknown key, so a hallucinated or misspelled field is
 * silently dropped and the edit proceeds against an input nobody wrote.
 */
const inputSchema = z
	.object({
		path: z
			.string()
			.refine((value) => value.trim().length > 0, 'Path must not be empty.')
			.describe('Path to the file to edit. Must not be empty.'),
		old_string: z
			.string()
			.min(1)
			.optional()
			.describe('The exact string to find and replace. Must be unique in the file.'),
		oldStr: z
			.string()
			.min(1)
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
			.union([z.coerce.number().int().min(0), z.string().min(1)])
			.optional()
			.describe(
				'Optional line insertion target. Inserts the replacement after this 1-indexed line; 0 inserts before the first line; "end" appends to the file.',
			),
		replace_all: z
			.boolean()
			.default(false)
			.describe('Replace all occurrences instead of just the first unique match'),
	})
	.strict()
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

/**
 * What a capable provider constrains the model to emit: one shape, closed.
 *
 * The aliases above exist for hosts, not for models. A model offered
 * `old_string` and `oldStr` as separate optional fields has to guess which
 * one this deployment wants, and `additionalProperties: false` is what turns
 * an invented field into a generation-time refusal rather than a silent drop.
 */
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
		'Makes targeted edits to a file using exact string find-and-replace or line insertion. THIS IS THE PREFERRED WAY TO MODIFY AN EXISTING FILE — never reach for `write` to change a file that already exists, because `write` overwrites the whole body and discards earlier work on partial failure. `edit` keeps the rest of the file byte-for-byte intact and is recoverable: if a single edit fails (old_string/oldStr ambiguous, broader restructuring needed), follow up with another `edit` instead of re-emitting the entire file via `write`. The old_string/oldStr must be unique in the file unless replace_all is true. For insertions, pass insertLine plus new_string/newStr; use insertLine: "end" to extend a file at the end. Self-budget new_string/newStr under 12000 characters before emitting the tool call; use repeated bounded edits for long sections. Preserves file formatting and indentation.',
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
		// Re-validated here rather than trusted from the registry: `execute` is
		// reachable directly, and the closed contract is only closed if the
		// check runs on the path a caller can actually take.
		const parsed = inputSchema.safeParse(input)
		if (!parsed.success) {
			return {
				success: false,
				output: '',
				error: `Invalid edit input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
			}
		}

		const normalized = normalizeEditInput(parsed.data)
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

		const filePath = resolve(context.workingDirectory, parsed.data.path)
		// Read-modify-write is not atomic on its own: two edits to the same
		// path interleave their reads, and the second write lands on content
		// the first had already replaced — so one edit vanishes and the loser
		// reports "old_string not found", blaming the model for a race. The
		// key spans both branches because sandbox and local are distinct
		// files even when the path string matches.
		const lockKey = `${context.sandbox ? 'sandbox' : 'local'}:${filePath}`

		return withFileMutationLock(lockKey, async () => {
			if (context.sandbox) {
				const buffer = await context.sandbox.readFile(parsed.data.path)
				const result = applyEdit(buffer.toString('utf-8'), normalized.operation)
				if (!result.success) {
					return { success: false as const, output: '', error: result.error }
				}

				await context.sandbox.writeFile(parsed.data.path, result.content)
				return {
					success: true as const,
					output: `Edited ${parsed.data.path}: ${result.replacements} replacement(s) [sandboxed]`,
					data: { path: parsed.data.path, replacements: result.replacements, sandboxed: true },
				}
			}

			const content = await readFile(filePath, 'utf-8')
			const result = applyEdit(content, normalized.operation)
			if (!result.success) {
				return { success: false as const, output: '', error: result.error }
			}

			// Temp file, fsync, rename — a reader sees the old body or the new
			// one, never a half-written one. A plain `writeFile` that fails
			// partway leaves the user's source truncated.
			await atomicWriteFile(filePath, result.content)
			return {
				success: true as const,
				output: `Edited ${filePath}: ${result.replacements} replacement(s)`,
				data: { path: filePath, replacements: result.replacements },
			}
		})
	},
})

function normalizeEditInput(
	input: EditInput,
): { success: true; operation: NormalizedEditInput } | { success: false; error: string } {
	const newString = input.new_string ?? input.newStr
	if (typeof newString !== 'string') {
		return { success: false, error: 'Either new_string or newStr is required.' }
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
		return { success: false, error: 'Either old_string/oldStr or insertLine is required.' }
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
	value: string | number,
): { success: true; value: number | 'end' } | { success: false; error: string } {
	if (typeof value === 'string') {
		if (value.trim().toLowerCase() === 'end') return { success: true, value: 'end' }
		const parsed = Number(value)
		if (Number.isInteger(parsed) && parsed >= 0) return { success: true, value: parsed }
		return {
			success: false,
			error: 'insertLine must be a non-negative line number or "end".',
		}
	}
	return { success: true, value }
}

function applyEdit(
	content: string,
	input: NormalizedEditInput,
): { success: true; content: string; replacements: number } | { success: false; error: string } {
	if (input.operation === 'insert') {
		return applyLineInsert(content, input)
	}

	const replacement = normalizeLineEndings(content, input)

	if (!content.includes(replacement.oldString)) {
		return {
			success: false,
			error:
				'old_string/oldStr not found in file. Make sure the string matches exactly, including whitespace and indentation.',
		}
	}

	if (replacement.replace_all) {
		const parts = content.split(replacement.oldString)
		const replacements = parts.length - 1
		return {
			success: true,
			content: parts.join(replacement.newString),
			replacements,
		}
	}

	// Uniqueness check: old_string/oldStr must appear exactly once
	const firstIndex = content.indexOf(replacement.oldString)
	const secondIndex = content.indexOf(replacement.oldString, firstIndex + 1)

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
			replacement.newString +
			content.slice(firstIndex + replacement.oldString.length),
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

/**
 * Reconcile the caller's line endings with the file's.
 *
 * A model reading a CRLF file and writing back LF (or the reverse) produces
 * an `old_string` that is correct in every visible way and matches nothing.
 * The failure reads as "your text is wrong" when the text is right and only
 * the invisible half of each line break differs.
 *
 * Only applied when the file is CONSISTENT. A mixed-ending file has no
 * single right answer, and rewriting boundaries there would corrupt the
 * half that was already correct.
 */
function normalizeLineEndings(
	content: string,
	input: Extract<NormalizedEditInput, { operation: 'replace' }>,
): Extract<NormalizedEditInput, { operation: 'replace' }> {
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
