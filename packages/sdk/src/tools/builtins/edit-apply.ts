import type { EditInput } from './edit.js'

/**
 * The apply core `edit`'s tool definition calls at mutation time, pulled out
 * on its own so a second caller — the step-context projection that replays a
 * visible edit call to verify a claimed post-edit body — runs this exact
 * code instead of a parallel implementation that could drift from it (most
 * easily on the CRLF reconciliation below, which depends on the real file's
 * line-ending mix).
 *
 * Pure by construction: no filesystem access, no `ToolContext`. Everything
 * here is a function from strings to strings.
 */

export type NormalizedEditInput =
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
export function normalizeEditInput(
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
		return {
			success: false,
			error: 'Either old_string/oldStr or insertLine is required.',
		}
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
		// as the single largest source of tool-call waste in its turns.
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
export function applyEdit(
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
				error: framedError(result.error, index, operations.length),
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

/** The batch framing an operation's own error is reported under. */
function framedError(error: string, index: number, total: number): string {
	if (total === 1) return error
	return `edits[${index}] of ${total}: ${error} Nothing was written — the whole batch is refused, so the file is exactly as it was.`
}

/**
 * What a bounded replay did, and what it cost.
 *
 * A union rather than a throw because all three outcomes are ordinary answers
 * to a caller replaying somebody else's call: it applied, it would have built
 * more than the caller has room for, or it no longer applies to the content it
 * was handed. Only the first carries a body; the other two carry the charge so
 * the caller can settle the room the attempt actually used.
 */
export type BoundedReplay =
	| {
			readonly outcome: 'replayed'
			readonly content: string
			readonly charged: number
			readonly replacements: number
	  }
	| { readonly outcome: 'refused'; readonly charged: number }
	| {
			readonly outcome: 'failed'
			readonly charged: number
			readonly error: string
	  }

/**
 * The single door a caller outside this module uses.
 *
 * Runs a visible call's arguments through the same normalize-then-apply path
 * `EditTool.execute` runs at mutation time, against a content string the
 * caller already has in hand — never the filesystem — and under an
 * `allowance`: the largest string the caller is willing to have built on its
 * behalf.
 *
 * The allowance is honoured one OPERATION at a time. Each operation's
 * post-image length is worked out exactly from the content it is about to be
 * applied to, compared against the allowance, and only then applied — so
 * nothing over the ceiling is ever materialised, and nothing under it is
 * refused for a bound that guessed high. An earlier shape predicted the whole
 * call up front, which meant folding operations after the first against a
 * string it had never seen: a rename hunk at index 1 was charged one match per
 * anchor-length window of the file, and batches that would have fitted were
 * turned away for a number nothing had built.
 *
 * `charged` is the longest string this call actually materialised, which is
 * the one the caller paid for holding. It is the post-image length exactly for
 * the single-operation shape almost every call has; for a batch it is the
 * largest intermediate the fold built rather than the body it ends on, because
 * a batch that grows a file to twenty megabytes and then deletes every
 * character has still built the twenty megabytes. An operation that is refused
 * or fails is charged nothing — it built nothing — while the ones before it in
 * the same batch are charged, having run.
 */
export function replayEditCallWithin(
	content: string,
	rawArguments: unknown,
	allowance: number,
): BoundedReplay {
	const normalized = normalizeEditInput(rawArguments as EditInput)
	// A shape this cannot normalize is one the tool itself would have refused.
	// Reported as a failure rather than a throw, and charged nothing: no
	// operation ran, so nothing was built.
	if (!normalized.success) return { outcome: 'failed', charged: 0, error: normalized.error }
	return replayOperationsWithin(content, normalized.operations, allowance)
}

/**
 * The same walk, entered with the operations already normalized.
 *
 * Separate from the entry point above so the equivalence with {@link applyEdit}
 * can be exercised operation by operation — `replayOperationsWithin(c, [op], ∞)`
 * is `applyOne(c, op)` plus its exact predicted length — rather than only in
 * the aggregate, where a prediction that is wrong in two places by the same
 * amount would pass.
 */
export function replayOperationsWithin(
	content: string,
	operations: readonly NormalizedEditInput[],
	allowance: number,
): BoundedReplay {
	let current = content
	let replacements = 0
	// The largest body this call has built so far, which is what it has cost
	// the caller. Zero until an operation applies: a call refused at its first
	// operation built nothing and owes nothing.
	let charged = 0

	for (const [index, operation] of operations.entries()) {
		const predicted = predictOne(current, operation, allowance)
		if (predicted > allowance) return { outcome: 'refused', charged }
		const applied = applyOne(current, operation)
		if (!applied.success) {
			return {
				outcome: 'failed',
				charged,
				error: framedError(applied.error, index, operations.length),
			}
		}
		current = applied.content
		replacements += applied.replacements
		charged = Math.max(charged, current.length)
	}

	return { outcome: 'replayed', content: current, charged, replacements }
}

/**
 * The exact length `applyOne` would produce, without producing it.
 *
 * Exact and not a bound, because the content it is measured against is the
 * real one the operation is about to be applied to. The one place it stops
 * short is the occurrence scan for `replace_all`: counting out every match of
 * a one-character anchor in a large file is itself the work the allowance
 * exists to avoid, so the scan stops as soon as one more match would carry the
 * result past `allowance`. The number returned from a stopped scan is a lower
 * bound on the real length and above the allowance, which is all a refusal
 * needs.
 *
 * Here rather than in the caller because the prediction has to see the same
 * line-ending reconciliation `applyOne` sees. An `old_string` written with LF
 * against a CRLF file matches after normalization and not before, and a
 * predictor blind to that would count zero occurrences for a replacement that
 * was going to succeed.
 *
 * An operation that is not going to apply at all — an anchor that is missing,
 * or matches twice where one match was required — gets a number that means
 * nothing, and it is never used for anything but the comparison above: the
 * apply immediately after this reports the real refusal.
 */
function predictOne(content: string, operation: NormalizedEditInput, allowance: number): number {
	if (operation.operation === 'insert') {
		// `applyLineInsert` splits the inserted text into lines and joins it back
		// with the rest, which costs the text itself plus the one separator that
		// joins it to its neighbour — and a trailing newline in the text is
		// consumed as that separator rather than added to it.
		return (
			content.length + operation.newString.length + (operation.newString.endsWith('\n') ? 0 : 1)
		)
	}
	const { oldString, newString, replace_all } = normalizeLineEndings(content, operation)
	const growth = newString.length - oldString.length
	// A single replacement, because `applyOne` refuses a second match. The
	// clamp is for an anchor longer than the whole content: that operation is
	// about to fail, and a negative length would be a charge handing the caller
	// back room it never had.
	if (!replace_all) return Math.max(content.length + growth, 0)
	const room = Math.max(allowance - content.length, 0)
	// One past what fits is already a refusal, so the scan never needs to see
	// the match after that. A replacement no longer than its anchor cannot grow
	// the string however often it matches, so there is nothing to stop for.
	const cap = growth > 0 ? Math.floor(room / growth) + 1 : content.length
	return Math.max(content.length + countOccurrences(content, oldString, cap) * growth, 0)
}

/** Non-overlapping matches, up to `cap`, counted the way `split` counts them. */
function countOccurrences(content: string, needle: string, cap: number): number {
	// `split('')` yields one part per character; scanning for it would never
	// advance. Neither shape reaches here through the tool's schema, which
	// requires a non-empty `old_string`.
	if (needle.length === 0) return Math.min(Math.max(content.length - 1, 0), cap)
	let count = 0
	let index = content.indexOf(needle)
	while (index !== -1 && count < cap) {
		count += 1
		index = content.indexOf(needle, index + needle.length)
	}
	return count
}
