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

/**
 * The single door a caller outside this module uses.
 *
 * Runs a visible call's arguments through the same normalize-then-apply path
 * `EditTool.execute` runs at mutation time, against a content string the
 * caller already has in hand — never the filesystem. Throws rather than
 * returning a result union because every failure here (a malformed shape,
 * an old_string that no longer matches) means the replay could not be
 * trusted, and a caller building a projection from it wants that to abort
 * the attempt rather than be checked at every call site.
 */
export function replayEditCall(
	content: string,
	rawArguments: unknown,
): { success: true; content: string; replacements: number } {
	const normalized = normalizeEditInput(rawArguments as EditInput)
	if (!normalized.success) {
		throw new Error(normalized.error)
	}
	const result = applyEdit(content, normalized.operations)
	if (!result.success) {
		throw new Error(result.error)
	}
	return result
}

/**
 * An upper bound on the longest string `replayEditCall` will build, without
 * building it.
 *
 * A caller replaying a visible call against a budget has to refuse before the
 * work, not after: measuring the post-image by building it is exactly the cost
 * the budget exists to bound. `allowance` is that caller's remaining room, and
 * it stops the occurrence scan the moment one more match would carry the
 * prediction past it — counting out every occurrence of a one-character string
 * in a large file is itself the work being avoided. The number returned once
 * the allowance is passed is therefore a lower bound on the real length and
 * only good for refusing.
 *
 * Here rather than in the caller because the prediction has to see the same
 * line-ending reconciliation `applyOne` sees. An `old_string` written with LF
 * against a CRLF file matches after normalization and not before, and a
 * predictor blind to that would count zero occurrences for a replacement that
 * was going to succeed.
 *
 * Exact for a call carrying one operation, which is the shape almost every
 * call has. A batch folds each operation into the one its predecessor
 * produced, and those intermediates are strings this function never sees — so
 * from the second operation on it BOUNDS rather than counts, and the answer
 * covers the largest intermediate rather than the body the fold ends on. A
 * batch that grows a file to twenty megabytes and then deletes it all has
 * still built the twenty megabytes, and a caller told only the final length
 * would pay nothing for them. The cost is that a batch whose later hunks could
 * multiply is refused even where it would in fact have fitted; that is the
 * direction a bound is allowed to be wrong in.
 */
export function predictReplayLength(
	content: string,
	rawArguments: unknown,
	allowance: number,
): number {
	const normalized = normalizeEditInput(rawArguments as EditInput)
	// A shape this cannot normalize is one `replayEditCall` throws on. Predict
	// no growth and let the caller meet that throw where it already handles it,
	// rather than inventing a second refusal for the same input.
	if (!normalized.success) return content.length

	let length = content.length
	let peak = 0
	for (const [index, operation] of normalized.operations.entries()) {
		if (peak > allowance) return peak
		if (operation.operation === 'insert') {
			// `applyLineInsert` splits the inserted text into lines and joins it
			// back with the rest, which costs the text itself plus the one
			// separator that joins it to its neighbour — and a trailing newline
			// in the text is consumed as that separator rather than added to it.
			length += operation.newString.length + (operation.newString.endsWith('\n') ? 0 : 1)
		} else if (index === 0) {
			// The one operation whose subject this function is holding: counted
			// against the real string, reconciled the way `applyOne` will.
			const { oldString, newString } = normalizeLineEndings(content, operation)
			const growth = newString.length - oldString.length
			if (operation.replace_all) {
				const room = Math.max(allowance - length, 0)
				const cap = growth > 0 ? Math.floor(room / growth) + 1 : content.length
				length += countOccurrences(content, oldString, cap) * growth
			} else {
				// A single replacement, because `applyOne` refuses a second match.
				length += growth
			}
		} else {
			length += boundedGrowth(operation, length, allowance - length)
		}
		// A length is never negative, and an `old_string` longer than the text
		// it is applied to can make the arithmetic above one. That call is going
		// to throw on replay, but not before the caller has charged this — and a
		// negative charge would hand back room the request never had.
		length = Math.max(length, 0)
		peak = Math.max(peak, length)
	}
	// `peak` covers every string the fold builds; `length` covers the call that
	// builds none — an empty `edits` list, which the tool's schema refuses and
	// this entry point still has to answer for.
	return Math.max(peak, length)
}

/**
 * The most one operation past the first can add to a string of `length`.
 *
 * Everything after the first operation is applied to an intermediate this
 * module's caller never handed over, so neither the matches nor the
 * reconciliation are knowable here: the anchor may be collapsed to LF, the
 * replacement expanded to CRLF, and the text being searched is not the one in
 * hand. Bounding all three — the shortest the anchor can be, the longest the
 * replacement can be, and at most one non-overlapping match per anchor-length
 * window of the string — keeps the answer above whatever the fold does.
 */
function boundedGrowth(
	operation: Extract<NormalizedEditInput, { operation: 'replace' }>,
	length: number,
	room: number,
): number {
	const oldLength = operation.oldString.replaceAll('\r\n', '\n').length
	const newLength = operation.newString.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n').length
	const growth = newLength - oldLength
	// One match, because `applyOne` refuses a second.
	if (!operation.replace_all) return growth
	// A replacement no longer than its anchor cannot make the string longer,
	// however many times it matches, so there is nothing to bound.
	if (growth <= 0) return 0
	const matches = Math.min(
		Math.floor(length / Math.max(oldLength, 1)),
		// Past the caller's room the exact count stops mattering: one more than
		// fits is already a refusal.
		Math.floor(Math.max(room, 0) / growth) + 1,
	)
	return matches * growth
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
