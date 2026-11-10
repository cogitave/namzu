/**
 * Compiles one path segment of a glob (no `/` in it) to the regular expression
 * the file walk tests names with, in the same dialect the sandbox guest runs.
 * It covers `*`, `?`, `[...]` classes (with `!`/`^` negation, ranges and POSIX
 * classes), the five extglob forms and `\` escapes. A segment with no magic in
 * it comes back as the plain name to compare against.
 */

// Written for the `u` flag, which every compiled expression carries.
const POSIX_CLASSES: ReadonlyMap<string, string> = new Map(
	Object.entries({
		alnum: '\\p{L}\\p{Nl}\\p{Nd}',
		alpha: '\\p{L}\\p{Nl}',
		ascii: '\\x00-\\x7f',
		blank: '\\p{Zs}\\t',
		cntrl: '\\p{Cc}',
		digit: '\\p{Nd}',
		graph: '\\x21-\\x7e',
		lower: '\\p{Ll}',
		print: '\\x20-\\x7e',
		punct: '\\p{P}\\p{S}',
		space: '\\s',
		upper: '\\p{Lu}',
		word: '\\p{L}\\p{Nl}\\p{Nd}_',
		xdigit: '0-9a-fA-F',
	}),
)

export interface CompiledSegment {
	/** Set when the segment has no magic: the exact name it matches. */
	literal: string | null
	/** Source of an expression anchored with `^` and `$`, for a segment with magic. */
	source: string
}

/**
 * The longest segment, in UTF-16 code units, that `compileSegment` accepts. A
 * file name is at most 255 bytes on the file systems Namzu runs on, so a
 * pattern for one name beyond four times that is never legitimate, while
 * compiling a segment costs time in proportion to the square of its length.
 */
export const MAX_GLOB_SEGMENT_LENGTH = 1024

/** How much of an over-long pattern an error message shows, in code points. */
const PREVIEW_LENGTH = 60

/** The first `PREVIEW_LENGTH` code points of `text`, never cutting a surrogate pair. */
const preview = (text: string) =>
	Array.from(text.slice(0, PREVIEW_LENGTH * 2))
		.slice(0, PREVIEW_LENGTH)
		.join('')

/**
 * Raised for a segment that repeats a group (`*( )` or `+( )`) which could match
 * the same text more than one way. Such a group backtracks exponentially on a
 * name that nearly matches, and glob patterns come from untrusted input.
 */
export class GlobTooComplexError extends Error {
	readonly segment: string
	constructor(segment: string, reason: 'ambiguous' | 'stretch' | 'length' = 'ambiguous') {
		super(
			reason === 'length'
				? `The pattern '${preview(segment)}...' is too long (${segment.length} characters; at most ${MAX_GLOB_SEGMENT_LENGTH} between slashes); shorten it or split it across folders.`
				: reason === 'stretch'
					? `The pattern '${segment}' has more than three wildcards that can stretch; split it across folders or use fewer *.`
					: `The pattern '${segment}' repeats a group that can match the same text more than one way; use ** or {a,b} instead.`,
		)
		this.name = 'GlobTooComplexError'
		// An over-long pattern is not kept whole: the error may be logged.
		this.segment = reason === 'length' ? preview(segment) : segment
	}
}

const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
const escapeInClass = (text: string) => text.replace(/[\\^\]\[/-]/g, '\\$&')

interface Parsed {
	source: string
	literal: string
	magic: boolean
	/** Unbounded runs: each `*` (consecutive ones collapsed), `*( )` and `+( )`. */
	runs: number
}

/** Index of the `)` closing the group opened just before `from`, or -1. */
function closeGroup(text: string, from: number): number {
	let depth = 1
	for (let index = from; index < text.length; index += 1) {
		const ch = text[index]
		if (ch === '\\') index += 1
		else if (ch === '[') {
			const end = classEnd(text, index)
			if (end > 0) index = end
		} else if (ch === '(') depth += 1
		else if (ch === ')' && --depth === 0) return index
	}
	return -1
}

/** Index of the `]` closing the class opened at `start`, or -1 when it never closes. */
function classEnd(text: string, start: number): number {
	let index = start + 1
	if (text[index] === '!' || text[index] === '^') index += 1
	if (text[index] === ']') index += 1
	for (; index < text.length; index += 1) {
		const ch = text[index]
		if (ch === '\\') index += 1
		else if (ch === '[' && text[index + 1] === ':') {
			const end = text.indexOf(':]', index + 2)
			if (end > 0 && POSIX_CLASSES.has(text.slice(index + 2, end))) index = end + 1
		} else if (ch === ']') return index
	}
	return -1
}

function splitAlternatives(body: string): string[] {
	const parts: string[] = []
	let depth = 0
	let current = ''
	for (let index = 0; index < body.length; index += 1) {
		const ch = body[index] as string
		if (ch === '\\') {
			current += ch + (body[index + 1] ?? '')
			index += 1
			continue
		}
		if (ch === '[') {
			const end = classEnd(body, index)
			if (end > 0) {
				current += body.slice(index, end + 1)
				index = end
				continue
			}
		}
		if (ch === '(') depth += 1
		if (ch === ')') depth -= 1
		if (ch === '|' && depth === 0) {
			parts.push(current)
			current = ''
		} else current += ch
	}
	parts.push(current)
	return parts
}

function classSource(body: string): string {
	let index = 0
	let negate = false
	if (body[0] === '!' || body[0] === '^') {
		negate = true
		index = 1
	}
	let out = ''
	for (; index < body.length; index += 1) {
		const ch = body[index] as string
		if (ch === '[' && body[index + 1] === ':') {
			const end = body.indexOf(':]', index + 2)
			const name = end > 0 ? body.slice(index + 2, end) : ''
			const members = POSIX_CLASSES.get(name)
			if (members !== undefined) {
				out += members
				index = end + 1
				continue
			}
		}
		if (ch === '\\' && index + 1 < body.length) {
			index += 1
			out += escapeInClass(body[index] as string)
		} else if (ch === '-' && out !== '' && index + 1 < body.length) out += '-'
		else out += escapeInClass(ch)
	}
	const source = `[${negate ? '^' : ''}${out}]`
	try {
		new RegExp(source, 'u')
	} catch {
		// An out-of-order range such as `[z-a]` matches no name rather than failing the walk.
		return '(?!)'
	}
	return source
}

/** `guard`, when set, is put before each alternative of a group at the very start that does not itself spell out a leading `.`. */
function parse(text: string, guard = ''): Parsed {
	let source = ''
	let literal = ''
	let magic = false
	let runs = 0
	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index] as string
		const next = text[index + 1]
		if (ch === '\\') {
			if (next === undefined) {
				source += '\\\\'
				literal += '\\'
			} else {
				source += escapeRegex(next)
				literal += next
				index += 1
			}
		} else if (ch === '*' && next !== '(') {
			while (text[index + 1] === '*') index += 1
			source += '[^/]*?'
			runs += 1
			magic = true
		} else if (ch === '?' && next !== '(') {
			source += '[^/]'
			magic = true
		} else if (ch === '[') {
			const end = classEnd(text, index)
			if (end < 0) {
				source += '\\['
				literal += '['
			} else {
				source += classSource(text.slice(index + 1, end))
				magic = true
				index = end
			}
		} else if ('?*+@!'.includes(ch) && next === '(') {
			const end = closeGroup(text, index + 2)
			if (end < 0) {
				source += escapeRegex(ch)
				literal += ch
				continue
			}
			const parts = splitAlternatives(text.slice(index + 2, end)).map((a) => ({
				a,
				parsed: parse(a),
			}))
			// A repeated group is linear only when each repetition can be read one way:
			// plain literal alternatives, none a prefix of another (and none empty).
			if (ch === '*' || ch === '+') {
				const literals = parts.map((part) => part.parsed.literal)
				// A lone class is one character wide, so each repetition has one reading.
				const lone = parts.length === 1 && isOneClass(parts[0]?.a ?? '')
				const plain = lone || parts.every((part) => !part.parsed.magic)
				const prefixFree =
					lone ||
					literals.every(
						(one, i) =>
							one !== '' && literals.every((other, j) => i === j || !other.startsWith(one)),
					)
				if (!plain || !prefixFree) throw new GlobTooComplexError(text)
			}
			const alternatives = parts.map(
				({ a, parsed }) => (index === 0 && !startsWithDot(a) ? guard : '') + parsed.source,
			)
			const group = `(?:${alternatives.join('|')})`
			runs +=
				parts.reduce((sum, part) => sum + part.parsed.runs, 0) + (ch === '*' || ch === '+' ? 1 : 0)
			magic = true
			if (ch === '!') {
				const tail = parse(text.slice(end + 1))
				const rest = tail.source
				source += `(?:(?!${group}${rest}$)[^/]*?)${rest}`
				return { source, literal, magic, runs: runs + 1 + tail.runs }
			}
			source += ch === '@' ? group : `${group}${ch === '?' ? '?' : ch === '*' ? '*' : '+'}`
			index = end
		} else {
			source += escapeRegex(ch)
			literal += ch
		}
	}
	return { source, literal, magic, runs }
}

/** Whether the text is exactly one closed `[...]` class. */
function isOneClass(text: string): boolean {
	return text.startsWith('[') && classEnd(text, 0) === text.length - 1
}

/** Whether every name this segment can match begins with a literal `.` the pattern spells out. */
function startsWithDot(text: string): boolean {
	if (text.startsWith('.') || text.startsWith('\\.')) return true
	if (text.startsWith('[')) {
		const end = classEnd(text, 0)
		return end > 0 && text.slice(1, end) === '.'
	}
	return false
}

/** Whether the segment is a single `?(`, `*(`, `@(` or `+(` group, whose alternatives carry the leading-dot guard themselves. */
function isOneGroup(text: string): boolean {
	return (
		'?*@+'.includes(text[0] ?? '') && text[1] === '(' && closeGroup(text, 2) === text.length - 1
	)
}

/**
 * `dot` lets a wildcard match a name that starts with `.`; without it only a
 * segment that itself begins with a literal `.` can.
 */
export function compileSegment(segment: string, dot: boolean): CompiledSegment {
	if (segment.length > MAX_GLOB_SEGMENT_LENGTH) throw new GlobTooComplexError(segment, 'length')
	const guard = dot ? '' : '(?!\\.)'
	let parsed: Parsed
	try {
		parsed = parse(segment, guard)
	} catch (error) {
		throw error instanceof GlobTooComplexError
			? new GlobTooComplexError(segment, 'ambiguous')
			: error
	}
	if (parsed.runs > 3) throw new GlobTooComplexError(segment, 'stretch')
	if (!parsed.magic) return { literal: parsed.literal, source: `^${parsed.source}$` }
	const grouped = (segment.startsWith('@(') || segment.startsWith('+(')) && !dot
	const lead = grouped || dot || startsWithDot(segment) || isOneGroup(segment) ? '' : guard
	return { literal: null, source: `^${lead}(?:${parsed.source})$` }
}
