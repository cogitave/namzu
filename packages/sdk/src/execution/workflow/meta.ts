import { WorkflowScriptError } from './errors.js'
import type { WorkflowMeta, WorkflowPhaseMeta } from './types.js'

const MAX_META_BYTES = 16 * 1024
const MAX_DEPTH = 8
const MAX_PHASES = 50
const KEYWORD = /export\s+const\s+meta\s*=/y

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal }

/**
 * Reads the `export const meta = {...}` literal WITHOUT running the script.
 *
 * The statement must be the first one in the file (comments and blank lines
 * before it are fine) and its value must be a pure literal: strings, numbers,
 * booleans, null, arrays and objects. Variables, calls, spreads, template
 * substitutions and computed keys are refused with a plain message, because
 * the operator reviews this literal BEFORE the script is allowed to run.
 */
class LiteralParser {
	pos = 0

	constructor(private readonly source: string) {}

	fail(what: string): never {
		const before = this.source.slice(0, this.pos)
		const line = before.split('\n').length
		const column = this.pos - before.lastIndexOf('\n')
		throw new WorkflowScriptError(`${what} (line ${line}, column ${column}).`)
	}

	skipTrivia(): void {
		const s = this.source
		for (;;) {
			const c = s[this.pos]
			if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') this.pos++
			else if (c === '/' && s[this.pos + 1] === '/') {
				while (this.pos < s.length && s[this.pos] !== '\n') this.pos++
			} else if (c === '/' && s[this.pos + 1] === '*') {
				const end = s.indexOf('*/', this.pos + 2)
				if (end === -1) this.fail('Unterminated comment')
				this.pos = end + 2
			} else return
		}
	}

	private describe(): string {
		const snippet = this.source.slice(this.pos, this.pos + 24).split('\n')[0]
		return snippet ? `"${snippet}"` : 'the end of the script'
	}

	private notLiteral(): never {
		return this.fail(
			`\`meta\` must be a pure literal (no variables, calls, spreads or expressions); found ${this.describe()}`,
		)
	}

	value(depth: number): Literal {
		if (depth > MAX_DEPTH) this.fail('`meta` is nested too deeply')
		this.skipTrivia()
		const c = this.source[this.pos]
		if (c === '{') return this.object(depth)
		if (c === '[') return this.array(depth)
		if (c === '"' || c === "'") return this.string(c)
		if (c === '`') return this.string('`')
		if (c === '-' || c === '.' || (c !== undefined && c >= '0' && c <= '9')) return this.number()
		for (const [word, value] of [
			['true', true],
			['false', false],
			['null', null],
		] as const) {
			if (
				this.source.startsWith(word, this.pos) &&
				!/[\w$]/.test(this.source[this.pos + word.length] ?? '')
			) {
				this.pos += word.length
				return value
			}
		}
		return this.notLiteral()
	}

	private number(): number {
		const match = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
		match.lastIndex = this.pos
		const found = match.exec(this.source)
		if (!found) return this.notLiteral()
		this.pos += found[0].length
		if (/[\w$]/.test(this.source[this.pos] ?? '')) return this.notLiteral()
		return Number(found[0])
	}

	private string(quote: string): string {
		const s = this.source
		this.pos++
		let out = ''
		for (;;) {
			const c = s[this.pos]
			if (c === undefined) return this.fail('Unterminated string in `meta`')
			if (c === quote) {
				this.pos++
				return out
			}
			if (c === '\n' && quote !== '`') return this.fail('Unterminated string in `meta`')
			if (quote === '`' && c === '$' && s[this.pos + 1] === '{') {
				return this.fail('`meta` strings cannot use `${...}` substitutions')
			}
			if (c !== '\\') {
				out += c
				this.pos++
				continue
			}
			const e = s[this.pos + 1]
			this.pos += 2
			const simple: Record<string, string> = {
				n: '\n',
				t: '\t',
				r: '\r',
				b: '\b',
				f: '\f',
				v: '\v',
				'0': '\0',
				'\\': '\\',
				"'": "'",
				'"': '"',
				'`': '`',
				$: '$',
			}
			if (e !== undefined && e in simple) out += simple[e]
			else if (e === '\n') continue
			else if (e === 'u' && s[this.pos] === '{') {
				const end = s.indexOf('}', this.pos)
				const hex = s.slice(this.pos + 1, end)
				if (end === -1 || !/^[0-9a-fA-F]{1,6}$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) {
					return this.fail('Bad escape in a `meta` string')
				}
				out += String.fromCodePoint(Number.parseInt(hex, 16))
				this.pos = end + 1
			} else if (e === 'u' || e === 'x') {
				const len = e === 'u' ? 4 : 2
				const hex = s.slice(this.pos, this.pos + len)
				if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex))
					return this.fail('Bad escape in a `meta` string')
				out += String.fromCharCode(Number.parseInt(hex, 16))
				this.pos += len
			} else return this.fail('Bad escape in a `meta` string')
		}
	}

	private array(depth: number): Literal[] {
		this.pos++
		const out: Literal[] = []
		for (;;) {
			this.skipTrivia()
			if (this.source[this.pos] === ']') {
				this.pos++
				return out
			}
			out.push(this.value(depth + 1))
			this.skipTrivia()
			if (this.source[this.pos] === ',') this.pos++
			else if (this.source[this.pos] !== ']') return this.notLiteral()
		}
	}

	private object(depth: number): { [key: string]: Literal } {
		this.pos++
		const out: { [key: string]: Literal } = Object.create(null)
		for (;;) {
			this.skipTrivia()
			const c = this.source[this.pos]
			if (c === '}') {
				this.pos++
				return out
			}
			let key: string
			if (c === '"' || c === "'") key = this.string(c)
			else {
				const ident = /[A-Za-z_$][\w$]*/y
				ident.lastIndex = this.pos
				const found = ident.exec(this.source)
				if (!found) return this.notLiteral()
				key = found[0]
				this.pos += key.length
			}
			if (key === '__proto__') this.fail('`meta` cannot define `__proto__`')
			if (key in out) this.fail(`\`meta\` repeats the key "${key}"`)
			this.skipTrivia()
			if (this.source[this.pos] !== ':') return this.notLiteral()
			this.pos++
			out[key] = this.value(depth + 1)
			this.skipTrivia()
			if (this.source[this.pos] === ',') this.pos++
			else if (this.source[this.pos] !== '}') return this.notLiteral()
		}
	}
}

function text(
	value: Literal | undefined,
	field: string,
	max: number,
	required: boolean,
): string | undefined {
	if (value === undefined) {
		if (required) throw new WorkflowScriptError(`\`meta.${field}\` is required.`)
		return undefined
	}
	if (typeof value !== 'string' || value.trim() === '') {
		throw new WorkflowScriptError(`\`meta.${field}\` must be a non-empty string.`)
	}
	if (value.length > max) {
		throw new WorkflowScriptError(`\`meta.${field}\` is longer than ${max} characters.`)
	}
	return value
}

function onlyKeys(
	object: { [key: string]: Literal },
	allowed: readonly string[],
	where: string,
): void {
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key)) {
			throw new WorkflowScriptError(
				`\`${where}\` has an unknown key "${key}". Allowed: ${allowed.join(', ')}.`,
			)
		}
	}
}

function isRecord(value: Literal | undefined): value is { [key: string]: Literal } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizePhaseTitle(value: string): string {
	return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function toMeta(literal: Literal): WorkflowMeta {
	if (!isRecord(literal)) throw new WorkflowScriptError('`meta` must be an object literal.')
	onlyKeys(literal, ['name', 'description', 'whenToUse', 'phases'], 'meta')
	const name = text(literal.name, 'name', 80, true) as string
	const description = text(literal.description, 'description', 500, true) as string
	const whenToUse = text(literal.whenToUse, 'whenToUse', 500, false)
	const phases: WorkflowPhaseMeta[] = []
	if (literal.phases !== undefined) {
		if (!Array.isArray(literal.phases)) {
			throw new WorkflowScriptError('`meta.phases` must be an array of { title, detail?, model? }.')
		}
		if (literal.phases.length > MAX_PHASES) {
			throw new WorkflowScriptError(`\`meta.phases\` lists more than ${MAX_PHASES} phases.`)
		}
		const seen = new Set<string>()
		for (const [i, entry] of literal.phases.entries()) {
			if (!isRecord(entry)) {
				throw new WorkflowScriptError(`\`meta.phases[${i}]\` must be an object with a title.`)
			}
			onlyKeys(entry, ['title', 'detail', 'model'], `meta.phases[${i}]`)
			const raw = text(entry.title, `phases[${i}].title`, 120, true) as string
			const title = normalizePhaseTitle(raw)
			if (seen.has(title)) {
				throw new WorkflowScriptError(`\`meta.phases\` repeats the title "${title}".`)
			}
			seen.add(title)
			const detail = text(entry.detail, `phases[${i}].detail`, 300, false)
			const model = text(entry.model, `phases[${i}].model`, 120, false)
			phases.push({
				title,
				...(detail !== undefined ? { detail } : {}),
				...(model !== undefined ? { model } : {}),
			})
		}
	}
	return {
		name,
		description,
		...(whenToUse !== undefined ? { whenToUse } : {}),
		phases,
	}
}

/**
 * Split a script into its `meta` and its body. The body keeps the script's
 * line breaks (the meta statement is blanked, not removed) so an error line
 * still points at the author's text.
 */
export function splitWorkflowScript(source: string): { meta: WorkflowMeta; body: string } {
	const parser = new LiteralParser(source)
	parser.skipTrivia()
	KEYWORD.lastIndex = parser.pos
	const found = KEYWORD.exec(source)
	if (!found) {
		throw new WorkflowScriptError(
			'A workflow script must start with `export const meta = { name, description, phases? }`.',
		)
	}
	const start = parser.pos
	parser.pos = start + found[0].length
	const literal = parser.value(0)
	parser.skipTrivia()
	if (source[parser.pos] === ';') parser.pos++
	if (Buffer.byteLength(source.slice(start, parser.pos)) > MAX_META_BYTES) {
		throw new WorkflowScriptError(`\`meta\` is larger than ${MAX_META_BYTES} bytes.`)
	}
	const meta = toMeta(literal)
	return {
		meta,
		body: source.slice(0, parser.pos).replace(/[^\n]/g, ' ') + source.slice(parser.pos),
	}
}

/** Parse `meta` from a script without executing it. Throws {@link WorkflowScriptError}. */
export function parseWorkflowMeta(source: string): WorkflowMeta {
	return splitWorkflowScript(source).meta
}
