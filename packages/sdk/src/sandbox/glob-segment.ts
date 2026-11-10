/**
 * Compiles one path segment of a glob (no `/` in it) to the regular expression
 * the file walk tests names with, in the same dialect the sandbox guest runs.
 * It covers `*`, `?`, `[...]` classes (with `!`/`^` negation, ranges and POSIX
 * classes), the five extglob forms and `\` escapes. A segment with no magic in
 * it comes back as the plain name to compare against.
 */

// Written for the `u` flag, which every compiled expression carries.
const POSIX_CLASSES: Record<string, string> = {
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
}

export interface CompiledSegment {
	/** Set when the segment has no magic: the exact name it matches. */
	literal: string | null
	/** Source of an expression anchored with `^` and `$`, for a segment with magic. */
	source: string
}

/**
 * Raised for a segment that repeats a group (`*( )` or `+( )`) which could match
 * the same text more than one way. Such a group backtracks exponentially on a
 * name that nearly matches, and glob patterns come from untrusted input.
 */
export class GlobTooComplexError extends Error {
	readonly segment: string
	constructor(segment: string) {
		super(
			`The pattern '${segment}' repeats a group that can match the same text more than one way; use ** or {a,b} instead.`,
		)
		this.name = 'GlobTooComplexError'
		this.segment = segment
	}
}

const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
const escapeInClass = (text: string) => text.replace(/[\\^\]\[/-]/g, '\\$&')

interface Parsed {
	source: string
	literal: string
	magic: boolean
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
			if (end > 0 && POSIX_CLASSES[text.slice(index + 2, end)]) index = end + 1
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
			if (POSIX_CLASSES[name]) {
				out += POSIX_CLASSES[name]
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
			magic = true
			if (ch === '!') {
				const rest = parse(text.slice(end + 1)).source
				source += `(?:(?!${group}${rest}$)[^/]*?)${rest}`
				return { source, literal, magic }
			}
			source += ch === '@' ? group : `${group}${ch === '?' ? '?' : ch === '*' ? '*' : '+'}`
			index = end
		} else {
			source += escapeRegex(ch)
			literal += ch
		}
	}
	return { source, literal, magic }
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
	const guard = dot ? '' : '(?!\\.)'
	let parsed: Parsed
	try {
		parsed = parse(segment, guard)
	} catch (error) {
		throw error instanceof GlobTooComplexError ? new GlobTooComplexError(segment) : error
	}
	if (!parsed.magic) return { literal: parsed.literal, source: `^${parsed.source}$` }
	const grouped = (segment.startsWith('@(') || segment.startsWith('+(')) && !dot
	const lead = grouped || dot || startsWithDot(segment) || isOneGroup(segment) ? '' : guard
	return { literal: null, source: `^${lead}(?:${parsed.source})$` }
}
