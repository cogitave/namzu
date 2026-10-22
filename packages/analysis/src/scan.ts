import { CUT_MARK, MAX_LITERAL_CHARS, type RowSink } from './walk.js'

/**
 * A scanner for text no parser would take.
 *
 * The last resort for a file with a syntax error that the parser's recovery
 * and a line-by-line repair could not get past: it still holds strings worth
 * finding and functions worth reading. This is not a parser. It knows
 * comments, quotes, template literals and braces, and it recognises the
 * anchor `function name(`. It finds no calls, no methods, no arrows and no
 * imports, and it can be wrong about a regular expression that looks like a
 * division. Everything it produces is stored on a file marked `degraded`, and
 * coverage says so.
 */

const ESCAPES: Record<string, string> = {
	n: '\n',
	t: '\t',
	r: '\r',
	b: '\b',
	f: '\f',
	v: '\v',
	'0': '\0',
}

function decodeEscapes(raw: string): string {
	if (!raw.includes('\\')) return raw
	return raw.replace(
		/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
		(_, e: string) => {
			if (e.length > 1) {
				const hex = e[0] === 'u' && e[1] === '{' ? e.slice(2, -1) : e.slice(1)
				const code = Number.parseInt(hex, 16)
				return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : e
			}
			return ESCAPES[e] ?? e
		},
	)
}

function capped(value: string): { value: string; cut: number } {
	if (value.length <= MAX_LITERAL_CHARS * 2) return { value, cut: 0 }
	return {
		value:
			value.slice(0, MAX_LITERAL_CHARS) + CUT_MARK + value.slice(value.length - MAX_LITERAL_CHARS),
		cut: value.length,
	}
}

const IDENT_START = /[A-Za-z_$\u0080-￿]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/

interface Spec {
	name: string
	start: number
	end: number
	parent: number
}

export function scanTolerantly(text: string, sink: RowSink): void {
	const specs: Spec[] = []
	const pendingStrings: Array<{
		start: number
		end: number
		kind: 'string' | 'template'
		value: string
		spec: number
	}> = []
	// Open braces: the function spec index the brace opens, or -1.
	const braces: number[] = []
	// A function seen but whose body has not opened yet.
	let waiting = -1
	let parens = 0
	let waitingParens = 0
	const open: number[] = []
	const current = (): number => (open.length > 0 ? (open[open.length - 1] as number) : -1)
	const n = text.length
	let i = 0
	while (i < n) {
		const c = text[i] as string
		if (c === '/' && text[i + 1] === '/') {
			while (i < n && text[i] !== '\n') i++
			continue
		}
		if (c === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2)
			i = close < 0 ? n : close + 2
			continue
		}
		if (c === '"' || c === "'") {
			let j = i + 1
			while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
			if (text[j] === c) {
				pendingStrings.push({
					start: i,
					end: j + 1,
					kind: 'string',
					value: decodeEscapes(text.slice(i + 1, j)),
					spec: current(),
				})
				i = j + 1
			} else i = j
			continue
		}
		if (c === '`') {
			let j = i + 1
			let chunk = j
			while (j < n && text[j] !== '`') {
				if (text[j] === '\\') {
					j += 2
					continue
				}
				if (text[j] === '$' && text[j + 1] === '{') {
					if (j > chunk) {
						pendingStrings.push({
							start: chunk,
							end: j,
							kind: 'template',
							value: decodeEscapes(text.slice(chunk, j)),
							spec: current(),
						})
					}
					let depth = 1
					j += 2
					while (j < n && depth > 0) {
						if (text[j] === '{') depth++
						else if (text[j] === '}') depth--
						j++
					}
					chunk = j
					continue
				}
				j++
			}
			if (j > chunk) {
				pendingStrings.push({
					start: chunk,
					end: j,
					kind: 'template',
					value: decodeEscapes(text.slice(chunk, j)),
					spec: current(),
				})
			}
			i = j + 1
			continue
		}
		if (c === '{') {
			if (waiting >= 0 && parens === waitingParens) {
				braces.push(waiting)
				open.push(waiting)
				waiting = -1
			} else braces.push(-1)
			i++
			continue
		}
		if (c === '}') {
			const top = braces.pop()
			if (top !== undefined && top >= 0) {
				;(specs[top] as Spec).end = i + 1
				open.pop()
			}
			i++
			continue
		}
		if (c === '(') parens++
		else if (c === ')') parens = Math.max(0, parens - 1)
		if (IDENT_START.test(c)) {
			let j = i + 1
			while (j < n && IDENT_PART.test(text[j] as string)) j++
			const word = text.slice(i, j)
			const before = i === 0 ? '' : (text[i - 1] as string)
			if (word === 'function' && !IDENT_PART.test(before) && before !== '.') {
				let k = j
				while (k < n && /\s/.test(text[k] as string)) k++
				if (text[k] === '*') {
					k++
					while (k < n && /\s/.test(text[k] as string)) k++
				}
				const nameStart = k
				while (k < n && IDENT_PART.test(text[k] as string)) k++
				const name = text.slice(nameStart, k)
				while (k < n && /\s/.test(text[k] as string)) k++
				if (name !== '' && text[k] === '(') {
					specs.push({ name, start: i, end: n, parent: current() })
					waiting = specs.length - 1
					waitingParens = parens
				}
			}
			i = j
			continue
		}
		i++
	}
	// Ids follow source order, as the parser's do.
	const order = specs
		.map((_, idx) => idx)
		.sort((a, b) => (specs[a] as Spec).start - (specs[b] as Spec).start)
	const idOf = new Map<number, number>()
	for (const idx of order) {
		const spec = specs[idx] as Spec
		idOf.set(
			idx,
			sink.fn({
				parentId: spec.parent < 0 ? null : (idOf.get(spec.parent) ?? null),
				kind: 'declaration',
				name: spec.name,
				qname: null,
				start: spec.start,
				end: spec.end,
			}),
		)
	}
	for (const s of pendingStrings) {
		const kept = capped(s.value)
		sink.strings.push({
			fnId: s.spec < 0 ? null : (idOf.get(s.spec) ?? null),
			start: s.start,
			end: s.end,
			kind: s.kind,
			value: kept.value,
			cut: kept.cut,
		})
	}
}
