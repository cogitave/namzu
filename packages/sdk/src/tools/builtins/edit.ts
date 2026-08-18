import { readFile } from 'node:fs/promises'

import { z } from 'zod'
import type { ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinReal } from '../paths.js'
import { atomicWriteFile } from './atomic-write-file.js'
import { fingerprintContent, staleFileError } from './content-fingerprint.js'
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
		// Optional rather than defaulted, for the reason given on the entry
		// field below: `execute` takes the schema's OUTPUT type, so a default
		// here makes `replace_all` mandatory for every hand-built call —
		// including a batch call, where the top-level flag means nothing at
		// all. The default is applied in `normalizeEditInput`.
		replace_all: z
			.boolean()
			.optional()
			.describe('Replace all occurrences instead of just the first unique match'),
		edits: z
			.array(
				z
					.object({
						old_string: z
							.string()
							.min(1)
							.describe('The exact string to find. Must be unique in the file at this point.'),
						new_string: z.string().describe('The replacement string.'),
						// `.optional()` where the top-level field uses `.default(false)`,
						// and the difference is about the CALLER rather than the
						// value. `execute` takes the schema's OUTPUT type, so a
						// defaulted field is required of everyone who builds a call
						// by hand — and a batch entry is built by hand far more
						// often than the top-level object is. The default lives in
						// `normalizeEditInput` instead, where it is applied once for
						// every entry.
						replace_all: z
							.boolean()
							.optional()
							.describe('Replace every occurrence of this old_string instead of requiring one.'),
					})
					.strict(),
			)
			.min(1)
			.optional()
			.describe(
				'Several replacements in one file, applied in order and committed together. Nothing is written unless every one applies.',
			),
	})
	.strict()
	.refine(
		(value) =>
			value.edits !== undefined ||
			typeof value.new_string === 'string' ||
			typeof value.newStr === 'string',
		{ message: 'Either new_string or newStr is required.' },
	)
	.refine(
		(value) =>
			value.edits !== undefined ||
			value.insertLine !== undefined ||
			typeof value.old_string === 'string' ||
			typeof value.oldStr === 'string',
		{ message: 'Either old_string/oldStr or insertLine is required.' },
	)
	// Refused rather than resolved. A call carrying both an `edits` list and a
	// top-level replacement is two different intentions in one object, and any
	// precedence this code picked would be a guess about which the model meant
	// — silently dropping the other. There is no reading of that which is safe:
	// the dropped half is an edit somebody believes was made.
	.refine(
		(value) =>
			value.edits === undefined ||
			(value.old_string === undefined &&
				value.oldStr === undefined &&
				value.new_string === undefined &&
				value.newStr === undefined &&
				value.insertLine === undefined),
		{
			message:
				'Use either `edits` or a single top-level edit, not both. Move the top-level old_string/new_string into the edits list.',
		},
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
		insertLine: {
			// The union the execution schema already accepts, stated so a
			// constrained decoder can emit it. Stating it as a union of an
			// integer and the literal `"end"` also makes the synonym problem
			// structurally impossible: `"EOF"`, `"append"` and `"last"` are
			// not emittable, because `"end"` is the only string the schema
			// admits.
			//
			// `anyOf`, NOT `oneOf`. Strict tool use validates against a SUBSET
			// of JSON Schema, and `oneOf` is not in it — the vendor rejects the
			// whole request with `tools.N.custom: Schema type 'oneOf' is not
			// supported`, so the tool never mounts and the turn dies before a
			// single token. Measured against the live API: strict + `oneOf` is
			// a 400, strict + `anyOf` is accepted, and non-strict + `oneOf` is
			// accepted — which is why nothing caught it. Both halves were
			// individually fine; only their combination fails, and strict is on
			// for every model at or above the gate.
			//
			// The two branches are disjoint, so `anyOf` and `oneOf` mean the
			// same thing here — nothing is loosened.
			//
			// `minimum` is gone for the same reason: numeric constraints are
			// outside the strict subset too. The bound is not lost — the
			// execution schema still enforces it, which is where a value that
			// crosses a boundary should be checked anyway.
			anyOf: [{ type: 'integer' }, { const: 'end' }],
			description:
				'Insert instead of replacing. The new_string goes after this 1-indexed line; 0 inserts before the first line; "end" appends. Omit for a find-and-replace.',
		},
		replace_all: {
			type: 'boolean',
			description: 'Replace every occurrence instead of requiring one unique match.',
		},
		edits: {
			// The batch shape. Stated as an array of the same two fields
			// rather than as a second tool, because a model offered two tools
			// that both edit a file spends a decision on every turn choosing
			// between them — and the choice carries no information.
			type: 'array',
			items: {
				type: 'object',
				properties: {
					old_string: {
						type: 'string',
						description: 'Exact text from the file at this point in the sequence.',
					},
					new_string: { type: 'string', description: 'Exact replacement text.' },
					replace_all: {
						type: 'boolean',
						description: 'Replace every occurrence of this old_string.',
					},
				},
				required: ['old_string', 'new_string'],
				additionalProperties: false,
			},
			description:
				'Several replacements in one file, applied in order and committed together. Nothing is written unless every one applies. Use this instead of several edit calls when the changes only make sense together.',
		},
	},
	// `old_string` is deliberately NOT required, and this is the fix.
	//
	// The tool's own description tells the model to append with `insertLine`,
	// and this schema forbade the field while `enforceModelInput` was on — so
	// the idiom the prompt ordered was the one idiom a constrained model could
	// not express. Requiring `old_string` reintroduces that, since an insert
	// has no text to match.
	//
	// Which of `old_string` / `insertLine` is present is decided by the two
	// refinements on the execution schema, which already exist and name what
	// is missing. That is a deliberate choice over a top-level `oneOf`: strict
	// structured-output modes are least surprising with a flat object, and a
	// discriminated union at the root is the construct most likely to be
	// rejected or quietly ignored by a provider. The cost is that an
	// incomplete call is now expressible and caught at execution rather than
	// at generation — paid knowingly, because the alternative is that a
	// working capability stays unreachable.
	//
	// `new_string` left the required list for exactly that reason, one shape
	// later: a batch call carries its replacements inside `edits` and has no
	// top-level `new_string` to give. This is the same trade, made the same
	// way — a third refinement names what is missing at execution, and it also
	// refuses a call that carries both shapes rather than picking one.
	required: ['path'],
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
		'Makes targeted edits to a file using exact string find-and-replace or line insertion. THIS IS THE PREFERRED WAY TO MODIFY AN EXISTING FILE — never reach for `write` to change a file that already exists, because `write` overwrites the whole body and discards earlier work on partial failure. `edit` keeps the rest of the file byte-for-byte intact and is recoverable: if a single edit fails (old_string/oldStr ambiguous, broader restructuring needed), follow up with another `edit` instead of re-emitting the entire file via `write`. The old_string/oldStr must be unique in the file unless replace_all is true. For insertions, pass insertLine plus new_string/newStr; use insertLine: "end" to extend a file at the end. Self-budget new_string/newStr under 12000 characters before emitting the tool call; use repeated bounded edits for long sections. Preserves file formatting and indentation. To make several changes to ONE file that only make sense together, send them as `edits`: a list of {old_string, new_string} applied in order and committed as one write — if any of them does not apply, nothing is written and the reply names which one, so the file is never left half-changed.',
	inputSchema,
	modelInputSchema,
	enforceModelInput: true,
	validationErrorHint:
		'Three shapes. Replace: {"path":"file.md","old_string":"exact unique text","new_string":"replacement text"} (optional "replace_all": true). Insert: {"path":"file.md","insertLine":"end","new_string":"text to add"} where insertLine is a non-negative line number or "end". Batch: {"path":"file.md","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]} applied in order, all or nothing. Exactly one of old_string, insertLine or edits — a call carrying more than one of them is refused rather than resolved.',
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,

	/**
	 * The diff this tool is about to make, described by the tool.
	 *
	 * A host used to reconstruct this by matching `name === 'edit'` and
	 * reaching into the arguments — which worked for exactly two builtin
	 * names and left every MCP or plugin tool that patches something with a
	 * truncated string. The knowledge of what an edit IS belongs here.
	 *
	 * `undefined` for an INSERT: there is no `before` text to diff against,
	 * and inventing an empty one would render as "the whole file was
	 * added". No opinion is the honest answer, and the host's generic label
	 * is a better one than a wrong diff.
	 */
	presentCall(input: EditInput) {
		const before = input.old_string ?? input.oldStr
		const after = input.new_string ?? input.newStr
		if (typeof before !== 'string' || typeof after !== 'string') return undefined
		return {
			kind: 'diff' as const,
			...(input.path ? { path: input.path } : {}),
			before,
			after,
		}
	},

	/**
	 * A label, for the same reason `write` gives one: the diff was already
	 * shown under the call, and repeating it under the result doubles the
	 * longest rows in a transcript to say nothing new. The host used to
	 * decide this by matching two names.
	 */
	presentResult(_input: EditInput, result: ToolResult) {
		return { kind: 'generic' as const, label: result.output?.split('\n')[0] ?? '' }
	},

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
		// Checked per operation, not for the call. A batch whose third entry is
		// a no-op is still a mistake worth naming: the model believed it was
		// changing something there, and a silent pass would leave it believing
		// that after the edit reported success.
		const noOp = normalized.operations.findIndex(
			(operation) =>
				operation.operation === 'replace' && operation.oldString === operation.newString,
		)
		if (noOp >= 0) {
			return {
				success: false,
				output: '',
				error:
					normalized.operations.length === 1
						? 'old_string/oldStr and new_string/newStr are identical — no change needed'
						: `edits[${noOp}]: old_string and new_string are identical — no change needed. Nothing was written.`,
			}
		}

		// Host-side containment, on the host branch only. The sandbox has its
		// own root and its own resolver; canonicalizing a sandbox-relative
		// path against the HOST filesystem asks a question about the wrong
		// machine, and answers it with whatever happens to exist there.
		const filePath = context.sandbox
			? undefined
			: await resolveWithinReal(context.workingDirectory, parsed.data.path)
		// Read-modify-write is not atomic on its own: two edits to the same
		// path interleave their reads, and the second write lands on content
		// the first had already replaced — so one edit vanishes and the loser
		// reports "old_string not found", blaming the model for a race. The
		// key spans both branches because sandbox and local are distinct
		// files even when the path string matches.
		const lockKey = context.sandbox ? `sandbox:${parsed.data.path}` : `local:${filePath as string}`

		return withFileMutationLock(lockKey, async () => {
			if (context.sandbox) {
				const buffer = await context.sandbox.readFile(parsed.data.path)
				const result = applyEdit(buffer.toString('utf-8'), normalized.operations)
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

			const hostPath = filePath as string
			const content = await readFile(hostPath, 'utf-8')

			const result = applyEdit(content, normalized.operations)
			if (!result.success) {
				// The anchor did not match what is on disk. Two very different
				// situations produce that, and the difference is the whole
				// value of the fingerprint:
				//
				// The file is as the agent left it, and the anchor is simply
				// wrong — "not found, match the whitespace exactly" is the
				// right thing to say.
				//
				// Or the file moved after the read — a person in an editor,
				// another process, a second agent — and the same message is a
				// lie that sends the agent to re-check text that was never the
				// problem, so it retries the identical edit against the same
				// moved file.
				//
				// Deliberately NOT a gate on the successful path. An anchor
				// that still matches uniquely is well defined however much
				// changed elsewhere in the file, and refusing there would
				// reject safe edits every time anyone touched an unrelated
				// line.
				const seen = context.fileReadTracker?.fingerprint?.(hostPath)
				if (seen !== undefined && seen !== fingerprintContent(content)) {
					return { success: false as const, output: '', error: staleFileError(hostPath) }
				}
				return { success: false as const, output: '', error: result.error }
			}

			// Temp file, fsync, rename — a reader sees the old body or the new
			// one, never a half-written one. A plain `writeFile` that fails
			// partway leaves the user's source truncated.
			await atomicWriteFile(hostPath, result.content)
			// This runtime is now the last writer, so the next edit in the same
			// turn compares against what we just wrote rather than the read
			// before it.
			context.fileReadTracker?.recordRead(hostPath, result.content)
			return {
				success: true as const,
				output: `Edited ${hostPath}: ${result.replacements} replacement(s)`,
				data: { path: hostPath, replacements: result.replacements },
			}
		})
	},
})

/**
 * Turn one call into the ordered list of operations it stands for.
 *
 * A list rather than a single operation because the batch shape is not a
 * different kind of edit, only a longer one. Keeping ONE representation is
 * what stops the two shapes diverging: everything below this function — the
 * uniqueness check, the CRLF reconciliation, the identical-text refusal, the
 * atomic write — sees a list of length one for a single edit and never learns
 * which shape the caller used.
 */
function normalizeEditInput(
	input: EditInput,
): { success: true; operations: NormalizedEditInput[] } | { success: false; error: string } {
	if (input.edits !== undefined) {
		return {
			success: true,
			operations: input.edits.map((edit) => ({
				operation: 'replace' as const,
				oldString: edit.old_string,
				newString: edit.new_string,
				replace_all: edit.replace_all ?? false,
			})),
		}
	}

	const newString = input.new_string ?? input.newStr
	if (typeof newString !== 'string') {
		return { success: false, error: 'Either new_string or newStr is required.' }
	}

	if (input.insertLine !== undefined) {
		const insertLine = normalizeInsertLine(input.insertLine)
		if (!insertLine.success) return insertLine
		return {
			success: true,
			operations: [
				{
					operation: 'insert',
					insertLine: insertLine.value,
					newString,
					replace_all: input.replace_all ?? false,
				},
			],
		}
	}

	const oldString = input.old_string ?? input.oldStr
	if (typeof oldString !== 'string') {
		return { success: false, error: 'Either old_string/oldStr or insertLine is required.' }
	}
	return {
		success: true,
		operations: [
			{
				operation: 'replace',
				oldString,
				newString,
				replace_all: input.replace_all ?? false,
			},
		],
	}
}

/**
 * Spellings of "the end of the file" a model reaches for.
 *
 * Liberal here and strict in the schema, which is the right way round: the
 * schema makes `"end"` the only emittable string for a provider that
 * constrains, and this catches the rest for one that does not. None of these
 * is ambiguous — accepting them is not guessing at intent, it is declining to
 * spend a round trip on a synonym.
 */
const END_ALIASES = new Set(['end', 'eof', 'append', 'last', 'end_of_file', 'end-of-file'])

function normalizeInsertLine(
	value: string | number,
): { success: true; value: number | 'end' } | { success: false; error: string } {
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase()
		// `"end"` is the only spelling the model-facing schema admits, so a
		// constrained decoder cannot produce anything else. These aliases are
		// for the providers that do not constrain: a model reading "appends to
		// the file" reaches for the word it knows, and every one of these says
		// the same unambiguous thing. Refusing them bought strictness and cost
		// a full model round trip per occurrence — measured by a consuming host
		// as the single largest source of tool-call waste in its runs.
		if (END_ALIASES.has(normalized)) return { success: true, value: 'end' }
		const parsed = Number(value)
		if (Number.isInteger(parsed) && parsed >= 0) return { success: true, value: parsed }
		return {
			success: false,
			error: `insertLine must be a non-negative line number or "end" (also accepted: ${[...END_ALIASES].filter((a) => a !== 'end').join(', ')}). Received ${JSON.stringify(value)}.`,
		}
	}
	return { success: true, value }
}

/**
 * Apply every operation in order, or none of them.
 *
 * "Or none" is the whole reason this takes a list. Four related changes sent
 * as four calls are four chances to stop halfway, and the file left behind
 * after the third succeeded and the fourth did not is in a state no one wrote
 * and no one is looking at. Here the fold runs entirely in memory and the
 * caller writes once, so a failure anywhere leaves the file exactly as it was.
 *
 * Each operation matches against the content as the ones before it left it,
 * not against the original. That is what lets a later edit target text an
 * earlier one produced — and it is also why a failure names the INDEX: by the
 * time hunk 3 fails, the string it was looking for may have been consumed by
 * hunk 1, and "old_string not found" without a position sends the model to
 * re-check the wrong hunk.
 */
function applyEdit(
	content: string,
	operations: readonly NormalizedEditInput[],
): { success: true; content: string; replacements: number } | { success: false; error: string } {
	let current = content
	let replacements = 0

	for (const [index, operation] of operations.entries()) {
		const result = applyOne(current, operation)
		if (!result.success) {
			return {
				success: false,
				error:
					operations.length === 1
						? result.error
						: `edits[${index}] of ${operations.length}: ${result.error} Nothing was written — the whole batch is refused, so the file is exactly as it was.`,
			}
		}
		current = result.content
		replacements += result.replacements
	}

	return { success: true, content: current, replacements }
}

function applyOne(
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
