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
 * The strategies and their order are fixed as follows, so an edit that matches
 * under one of them matches here:
 *
 *   1. exact
 *   2. curly vs straight quotes, both directions
 *   3. `\uXXXX` escape in `old_string`, character in the file
 *   4. character in `old_string`, `\uXXXX` escape in the file
 *
 * Prompt delimiters from a transcript format (`<fnr>` →
 * `<function_results>`, `\n\nH:` → `\n\nHuman:`, …) are deliberately NOT
 * expanded: those tokens are artifacts of a transcript format,
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

/** Spaces a tab stands for when indentation of different styles is compared. */
const TAB_WIDTHS = [4, 2, 8] as const

/** The result of finding `old_string` again by its content alone, ignoring how it was indented. */
export interface IndentedMatch {
	/** The real span of the file the lines occupy. */
	readonly span: string
	/** `new_string`, re-indented by the difference the match found. */
	readonly newString: string
}

function leadingWhitespace(line: string): string {
	let end = 0
	while (end < line.length && (line[end] === ' ' || line[end] === '\t')) end++
	return line.slice(0, end)
}

function indentWidth(indent: string, tab: number): number {
	let width = 0
	for (const ch of indent) width += ch === '\t' ? tab : 1
	return width
}

function isBlank(line: string): boolean {
	return line.trim() === ''
}

/** The text of a line apart from its indentation and trailing whitespace. */
function lineKey(line: string): string {
	return line.trim()
}

/**
 * Find `oldString` in `content` by comparing lines with their leading and
 * trailing whitespace ignored, for the case where the model copied the right
 * lines with the wrong indentation (the usual cause: one level short, because
 * the first tab of an indented line was taken for a separator).
 *
 * Applies only when ALL of these hold, and otherwise answers null:
 *
 *   - exactly one run of lines in the file matches (a second place is
 *     ambiguous, and nothing is guessed);
 *   - the indentation differs by the same amount on every non-blank line
 *     (the model's text is the file's text shifted, not a different shape);
 *   - at least one line is not blank.
 *
 * The shift is measured in columns with a tab counted as 4, 2 or 8 spaces
 * (the first that makes the shift constant), and `newString` is moved by the
 * same number of columns in the file's own style, so a tab-indented file stays
 * tab-indented. Only leading whitespace is ever changed.
 */
export function resolveIndentedMatch(
	content: string,
	oldString: string,
	newString: string,
): IndentedMatch | null {
	const wanted = oldString.split('\n')
	const endsWithNewline = wanted.length > 1 && wanted[wanted.length - 1] === ''
	if (endsWithNewline) wanted.pop()
	if (wanted.every(isBlank)) return null
	// A leading blank line has no content to anchor on and a trailing one is
	// whitespace the model added; neither is part of what is compared.
	const wantedKeys = wanted.map(lineKey)

	const lines = content.split('\n')
	const keys = lines.map(lineKey)
	const first = wantedKeys.findIndex((key) => key !== '')
	let found = -1
	for (let at = 0; at + wanted.length <= lines.length; at++) {
		// biome-ignore lint/style/noNonNullAssertion: index < length
		if (keys[at + first]! !== wantedKeys[first]!) continue
		let same = true
		for (let i = 0; i < wanted.length; i++) {
			if (keys[at + i] !== wantedKeys[i]) {
				same = false
				break
			}
		}
		if (!same) continue
		if (found !== -1) return null
		found = at
	}
	if (found === -1) return null

	const pairs: { file: string; model: string }[] = []
	for (let i = 0; i < wanted.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: index < length
		const model = wanted[i]!
		if (isBlank(model)) continue
		// biome-ignore lint/style/noNonNullAssertion: index < length
		pairs.push({ file: leadingWhitespace(lines[found + i]!), model: leadingWhitespace(model) })
	}

	let tab = 0
	let delta = 0
	for (const candidate of TAB_WIDTHS) {
		const [head, ...rest] = pairs
		if (head === undefined) return null
		const shift = indentWidth(head.file, candidate) - indentWidth(head.model, candidate)
		if (
			rest.every((p) => indentWidth(p.file, candidate) - indentWidth(p.model, candidate) === shift)
		) {
			tab = candidate
			delta = shift
			break
		}
	}
	if (tab === 0) return null

	const fileUsesTabs = pairs.some((p) => p.file.includes('\t'))
	const render = (width: number): string => {
		if (!fileUsesTabs) return ' '.repeat(width)
		return '\t'.repeat(Math.floor(width / tab)) + ' '.repeat(width % tab)
	}
	const modelUsesTabs = pairs.some((p) => p.model.includes('\t'))
	const shifted =
		delta === 0 && fileUsesTabs === modelUsesTabs
			? newString
			: newString
					.split('\n')
					.map((line) => {
						if (isBlank(line)) return line
						const indent = leadingWhitespace(line)
						const width = Math.max(0, indentWidth(indent, tab) + delta)
						return render(width) + line.slice(indent.length)
					})
					.join('\n')

	let start = 0
	for (let i = 0; i < found; i++) start += (lines[i] as string).length + 1
	let end = start
	for (let i = 0; i < wanted.length; i++)
		end += (lines[found + i] as string).length + (i < wanted.length - 1 ? 1 : 0)
	if (endsWithNewline) {
		if (content[end] === '\n') end += 1
	} else if (content[end - 1] === '\r') {
		end -= 1
	}
	return { span: content.slice(start, end), newString: shifted }
}

/** How a line's indentation reads, for a message: "2 tabs", "4 spaces", "none". */
export function describeIndent(line: string): string {
	const indent = leadingWhitespace(line)
	if (indent === '') return 'no indentation'
	const tabs = [...indent].filter((c) => c === '\t').length
	const spaces = indent.length - tabs
	const parts: string[] = []
	if (tabs > 0) parts.push(`${tabs} ${tabs === 1 ? 'tab' : 'tabs'}`)
	if (spaces > 0) parts.push(`${spaces} ${spaces === 1 ? 'space' : 'spaces'}`)
	return parts.join(' and ')
}

/** A line with its indentation and trailing whitespace made visible: `→` is a tab, `·` a space. */
export function showWhitespace(line: string): string {
	const indent = leadingWhitespace(line)
	const body = line.slice(indent.length).replace(/[ \t\r]+$/, (tail) => {
		return tail.replaceAll('\t', '→').replaceAll(' ', '·').replaceAll('\r', '⏎')
	})
	return indent.replaceAll('\t', '→').replaceAll(' ', '·') + body
}
