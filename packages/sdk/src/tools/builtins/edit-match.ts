/**
 * Flexible `old_string` matching for the edit tool.
 *
 * When an exact match of `old_string` against the file fails, a handful of
 * near-misses are not the model being wrong about the text, only about one
 * invisible or interchangeable detail: a curly quote where the file has a
 * straight one, or a `\uXXXX` escape where the file has the character itself
 * (or the reverse). This module recovers the real span the model meant, and
 * carries the same transformation across to `new_string` so the replacement
 * stays consistent with what it replaced.
 *
 * The strategies and their order are a faithful port of the reference client's
 * file-edit resolver (the `lje`/`b`/`_`/`L`/`k`/`R`/`C`/`cDs`/`ipt`/`H`/`Q`/`N`
 * functions in its shipped bundle), so an edit that lands there lands here:
 *
 *   1. exact
 *   2. curly vs straight quotes, both directions
 *   3. `\uXXXX` escape in `old_string`, character in the file
 *   4. character in `old_string`, `\uXXXX` escape in the file
 *
 * The reference also expands a map of its own prompt delimiters (`<fnr>` →
 * `<function_results>`, `\n\nH:` → `\n\nHuman:`, …). That is deliberately NOT
 * ported: those tokens are artifacts of that client's own transcript format,
 * not a mismatch a Namzu model produces against a real source file.
 *
 * Pure by construction, like `edit-apply`: every function here is from strings
 * to strings, with no filesystem access.
 */

const LEFT_SINGLE_QUOTE = '‘'
const RIGHT_SINGLE_QUOTE = '’'
const LEFT_DOUBLE_QUOTE = '“'
const RIGHT_DOUBLE_QUOTE = '”'

/** `old_string` carries a `\uXXXX` escape the file may hold as a character. */
const HAS_UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/
/** `old_string` carries a non-ASCII character the file may hold as an escape. */
const HAS_NON_ASCII = /[\u0080-￿]/

/** Curly quotes to straight. Length-preserving: one character for one. */
function straightenQuotes(text: string): string {
	return text
		.replaceAll(LEFT_SINGLE_QUOTE, "'")
		.replaceAll(RIGHT_SINGLE_QUOTE, "'")
		.replaceAll(LEFT_DOUBLE_QUOTE, '"')
		.replaceAll(RIGHT_DOUBLE_QUOTE, '"')
}

/**
 * Replace each `\uXXXX` escape with its character, leaving an escaped
 * backslash (`\\`) untouched so `\\u0041` stays the five characters it is
 * rather than becoming a stray `A`.
 */
function decodeUnicodeEscapes(text: string): string {
	return text.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (whole, backslashes, hex) =>
		backslashes !== undefined ? whole : String.fromCharCode(Number.parseInt(hex, 16)),
	)
}

/** The length `text` would have if every non-ASCII character were a `\uXXXX`. */
function escapedLength(text: string): number {
	let nonAscii = 0
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 128) nonAscii++
	return text.length + 5 * nonAscii
}

/** Consecutive backslashes immediately before index `at`. */
function trailingBackslashes(text: string, at: number): number {
	let count = 0
	while (text[at - 1 - count] === '\\') count++
	return count
}

/** Escape a literal string so it matches itself inside a `RegExp`. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A pattern that matches `model` where every non-ASCII character appears as its
 * `\uXXXX` escape (case-insensitive in the hex letters) and every ASCII
 * character appears literally. Used to find, in a file written with escapes,
 * the span a model wrote with the characters themselves.
 */
function buildEscapeTolerantPattern(model: string): string {
	let pattern = ''
	for (let i = 0; i < model.length; i++) {
		const code = model.charCodeAt(i)
		if (code >= 128) {
			pattern += '\\\\u'
			for (const digit of code.toString(16).padStart(4, '0'))
				pattern += digit >= 'a' ? `[${digit}${digit.toUpperCase()}]` : digit
		} else {
			// biome-ignore lint/style/noNonNullAssertion: index < length
			pattern += escapeRegExp(model[i]!)
		}
	}
	return pattern
}

/**
 * Find, in `file`, the escaped form of `model` — where `model` is written with
 * real non-ASCII characters and `file` holds them as `\uXXXX`. Returns the
 * matched (escaped) substring, or null when there is no such span, when the
 * pattern would be ambiguous, or when a matched `\u` is itself escaped by an
 * odd run of backslashes (a literal `\u`, not an escape).
 */
function findEscapedForm(model: string, file: string): string | null {
	// A model ending in an odd number of backslashes cannot be the clean prefix
	// of an escape sequence; bail rather than build a pattern that misreads it.
	if (trailingBackslashes(model, model.length) % 2 === 1) return null

	// Offsets, within the escaped match, whose backslash parity must be checked
	// so a literal `\u` in the file is not mistaken for an escape.
	const sensitiveOffsets: number[] = model[0] === '\\' ? [0] : []
	let offset = 0
	for (let i = 0; i < model.length; i++) {
		if (model.charCodeAt(i) >= 128) {
			sensitiveOffsets.push(offset)
			offset += 6
		} else {
			offset += 1
		}
	}

	let regex: RegExp
	try {
		regex = new RegExp(buildEscapeTolerantPattern(model), 'g')
	} catch {
		return null
	}
	for (let match = regex.exec(file); match !== null; match = regex.exec(file)) {
		const at = match.index
		if (sensitiveOffsets.every((o) => trailingBackslashes(file, at + o) % 2 === 0)) {
			return file.indexOf(match[0]) === at ? match[0] : null
		}
		regex.lastIndex = at + 1
	}
	return null
}

/**
 * The span of `content` that `oldString` refers to, recovering it across a
 * quote- or escape-only difference, or null when nothing matches even then.
 *
 * The returned string is a real substring of `content` (or its escaped form),
 * so the caller can run the ordinary uniqueness check and splice against it.
 */
export function resolveOldString(content: string, oldString: string): string | null {
	if (content.includes(oldString)) return oldString

	const straight = straightenQuotes(oldString)
	const quoteIndex = straightenQuotes(content).indexOf(straight)
	if (quoteIndex !== -1) return content.substring(quoteIndex, quoteIndex + oldString.length)

	if (HAS_UNICODE_ESCAPE.test(oldString)) {
		const decoded = decodeUnicodeEscapes(oldString)
		if (decoded !== oldString && content.includes(decoded)) return decoded
	}

	if (HAS_NON_ASCII.test(oldString)) {
		if (escapedLength(oldString) > content.length || !content.includes('\\u')) return null
		return findEscapedForm(oldString, content)
	}

	return null
}

/** Is `char` at `index` opening a quote (preceded by a boundary) rather than closing one? */
function isOpeningPosition(chars: readonly string[], index: number): boolean {
	if (index === 0) return true
	const before = chars[index - 1]
	return (
		before === ' ' ||
		before === '\t' ||
		before === '\n' ||
		before === '\r' ||
		before === '(' ||
		before === '[' ||
		before === '{' ||
		before === '—' ||
		before === '–'
	)
}

/** Apply curly double quotes to `text`, choosing opening vs closing by context. */
function curlifyDoubleQuotes(text: string): string {
	const chars = [...text]
	return chars
		.map((char, index) =>
			char === '"'
				? isOpeningPosition(chars, index)
					? LEFT_DOUBLE_QUOTE
					: RIGHT_DOUBLE_QUOTE
				: char,
		)
		.join('')
}

/** Apply curly single quotes to `text`; an apostrophe between letters is always closing. */
function curlifySingleQuotes(text: string): string {
	const chars = [...text]
	return chars
		.map((char, index) => {
			if (char !== "'") return char
			const before = index > 0 ? chars[index - 1] : undefined
			const after = index < chars.length - 1 ? chars[index + 1] : undefined
			const betweenLetters =
				before !== undefined && /\p{L}/u.test(before) && after !== undefined && /\p{L}/u.test(after)
			if (betweenLetters) return RIGHT_SINGLE_QUOTE
			return isOpeningPosition(chars, index) ? LEFT_SINGLE_QUOTE : RIGHT_SINGLE_QUOTE
		})
		.join('')
}

/**
 * Carry the transformation that matched `oldString` across to `newString`, so
 * the replacement matches the span it lands in rather than the literal the
 * model typed.
 *
 * `resolved` is what {@link resolveOldString} returned — equal to `oldString`
 * for an exact match (then `newString` is returned unchanged), and otherwise
 * the real span, which tells us which strategy fired.
 */
export function reconcileNewString(oldString: string, resolved: string, newString: string): string {
	if (resolved === oldString) return newString

	// character in old, escape in file: re-escape new's non-ASCII to the file's
	// hex spelling, matching the letter-case the file used.
	if (
		HAS_NON_ASCII.test(oldString) &&
		escapedLength(oldString) === resolved.length &&
		findEscapedForm(oldString, resolved) !== null
	) {
		const perChar = new Map<number, string>()
		let upper = 0
		let lower = 0
		for (let oldIndex = 0, resolvedIndex = 0; oldIndex < oldString.length; oldIndex++) {
			const code = oldString.charCodeAt(oldIndex)
			if (code >= 128) {
				const hex = resolved.slice(resolvedIndex + 2, resolvedIndex + 6)
				perChar.set(code, hex)
				for (const digit of hex)
					if (digit >= 'a' && digit <= 'f') lower++
					else if (digit >= 'A' && digit <= 'F') upper++
				resolvedIndex += 6
			} else {
				resolvedIndex += 1
			}
		}
		return newString.replace(/[\u0080-￿]/g, (char) => {
			const code = char.charCodeAt(0)
			const known = perChar.get(code)
			if (known !== undefined) return `\\u${known}`
			const hex = code.toString(16).padStart(4, '0')
			return `\\u${upper > lower ? hex.toUpperCase() : hex}`
		})
	}

	// escape in old, character in file: decode new's escapes to match.
	if (HAS_UNICODE_ESCAPE.test(oldString) && decodeUnicodeEscapes(oldString) === resolved) {
		return decodeUnicodeEscapes(newString)
	}

	// quote difference: re-apply the file's curly quotes to new, by kind.
	const hasCurlyDouble =
		resolved.includes(LEFT_DOUBLE_QUOTE) || resolved.includes(RIGHT_DOUBLE_QUOTE)
	const hasCurlySingle =
		resolved.includes(LEFT_SINGLE_QUOTE) || resolved.includes(RIGHT_SINGLE_QUOTE)
	let reconciled = newString
	if (hasCurlyDouble) reconciled = curlifyDoubleQuotes(reconciled)
	if (hasCurlySingle) reconciled = curlifySingleQuotes(reconciled)
	return reconciled
}
