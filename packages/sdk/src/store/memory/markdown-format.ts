/**
 * One memory as one Markdown file: YAML frontmatter, a blank line, the body.
 *
 * ```markdown
 * ---
 * name: tests-need-a-built-sdk
 * description: The CLI's tests import the SDK's dist, so build it first
 * type: feedback
 * status: active
 * createdAt: 2026-09-21T09:30:00.000Z
 * updatedAt: 2026-09-21T09:30:00.000Z
 * tags: ["testing"]
 * id: 0b6c2a4e-…
 * ---
 *
 * Run `pnpm -r build` before `pnpm --filter @namzu/cli test`.
 *
 * Why: the CLI resolves `@namzu/sdk` through its package exports.
 * How to apply: after any SDK change, before trusting a CLI failure.
 * ```
 *
 * **Deliberately not a YAML parser**, for the reason `utils/frontmatter.ts`
 * gives: a reader that half-understands YAML produces a value that passes
 * validation and means nothing. That reader cannot be reused here because it
 * refuses lists and mappings by design, and a memory has tags and metadata.
 * This one reads exactly three value spellings — a plain scalar, a
 * double-quoted JSON value (string, array or object; JSON is YAML's flow
 * syntax), a single-quoted YAML string — and a block list of those under a
 * key with no value. Everything else is refused with the file and line, as
 * is an unknown or repeated key: a key this build does not know is a field it
 * would silently drop on the next write.
 *
 * The writer only emits what the reader reads, so every file this store
 * writes parses back to the same record, body byte for byte.
 */

import type { MemoryStatus, MemoryType } from '../../types/memory/index.js'

/** Keys this build reads and writes, in the order it writes them. */
export const MEMORY_FRONTMATTER_KEYS = [
	'name',
	'description',
	'type',
	'status',
	'createdAt',
	'updatedAt',
	'tags',
	'id',
	'title',
	'summary',
	'format',
	'metadata',
	'schemaVersion',
] as const

export type MemoryFrontmatterKey = (typeof MEMORY_FRONTMATTER_KEYS)[number]

export type FrontmatterScalar = string | number | boolean | null
export type FrontmatterJson =
	| FrontmatterScalar
	| readonly FrontmatterJson[]
	| { readonly [key: string]: FrontmatterJson }

export interface ParsedMemoryFile {
	/** Plain scalars arrive as strings; the caller decides what each key's string means. */
	readonly values: ReadonlyMap<MemoryFrontmatterKey, FrontmatterJson>
	readonly body: string
}

export class MemoryFileFormatError extends Error {
	constructor(
		readonly file: string,
		readonly reason: string,
		readonly line?: number,
	) {
		super(`${file}${line === undefined ? '' : `:${line}`}: ${reason}`)
		this.name = 'MemoryFileFormatError'
	}
}

const KEYS = new Set<string>(MEMORY_FRONTMATTER_KEYS)
const FENCE = /^---[ \t]*$/
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/
const ITEM_LINE = /^[ \t]+-(?:[ \t]+(.*))?$/

function parseValue(raw: string, file: string, line: number): FrontmatterJson {
	const value = raw.trim()
	if (value.startsWith('"') || value.startsWith('[') || value.startsWith('{')) {
		try {
			return JSON.parse(value) as FrontmatterJson
		} catch {
			throw new MemoryFileFormatError(
				file,
				'a value starting with ", [ or { must be valid JSON (YAML flow syntax this reader implements)',
				line,
			)
		}
	}
	if (value.startsWith("'")) {
		if (value.length < 2 || !value.endsWith("'") || /(^|[^'])'(?!')/.test(value.slice(1, -1))) {
			throw new MemoryFileFormatError(file, 'an unterminated single-quoted string', line)
		}
		return value.slice(1, -1).replace(/''/g, "'")
	}
	if (/^[>|][-+]?$/.test(value) || value.startsWith('&') || value.startsWith('*')) {
		throw new MemoryFileFormatError(
			file,
			'block scalars, anchors and aliases are not supported; write a single-line value',
			line,
		)
	}
	return value
}

/**
 * Split a memory file into frontmatter values and body.
 *
 * The body is everything after the closing fence, less ONE leading newline
 * (the blank line the writer puts there) and ONE trailing newline (the one
 * the writer adds). Removing exactly one of each, not trimming, is what makes
 * a body that itself begins or ends with blank lines round-trip.
 */
export function parseMemoryFile(raw: string, file: string): ParsedMemoryFile {
	const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
	const lines = text.split('\n')
	if (!FENCE.test((lines[0] ?? '').replace(/\r$/, ''))) {
		throw new MemoryFileFormatError(
			file,
			'a memory file must start with a --- frontmatter fence',
			1,
		)
	}
	let closing = -1
	for (let i = 1; i < lines.length; i++) {
		if (FENCE.test((lines[i] ?? '').replace(/\r$/, ''))) {
			closing = i
			break
		}
	}
	if (closing < 0) throw new MemoryFileFormatError(file, 'the frontmatter is never closed')

	const values = new Map<MemoryFrontmatterKey, FrontmatterJson>()
	let listKey: MemoryFrontmatterKey | undefined
	let list: FrontmatterJson[] | undefined
	// A key with no value holds the empty string until a list item under it
	// makes it a list, which a caller then validates like any other value.
	const closeList = (): void => {
		if (listKey && list && list.length > 0) values.set(listKey, list)
		listKey = undefined
		list = undefined
	}
	for (let i = 1; i < closing; i++) {
		const lineNumber = i + 1
		const line = (lines[i] ?? '').replace(/\r$/, '')
		if (!line.trim() || line.trimStart().startsWith('#')) continue
		const item = ITEM_LINE.exec(line)
		if (item) {
			if (!list) {
				throw new MemoryFileFormatError(
					file,
					'a list item must follow a key with no value',
					lineNumber,
				)
			}
			list.push(parseValue(item[1] ?? '', file, lineNumber))
			continue
		}
		const pair = KEY_LINE.exec(line)
		if (!pair) {
			throw new MemoryFileFormatError(
				file,
				'expected "key: value" at the start of the line',
				lineNumber,
			)
		}
		closeList()
		const key = pair[1] ?? ''
		if (!KEYS.has(key)) {
			throw new MemoryFileFormatError(
				file,
				`unknown key "${key}"; this build reads ${MEMORY_FRONTMATTER_KEYS.join(', ')}`,
				lineNumber,
			)
		}
		const typedKey = key as MemoryFrontmatterKey
		if (values.has(typedKey)) {
			throw new MemoryFileFormatError(file, `"${key}" appears twice`, lineNumber)
		}
		const rawValue = pair[2]?.trim() ?? ''
		if (rawValue === '') {
			listKey = typedKey
			list = []
			values.set(typedKey, '')
			continue
		}
		values.set(typedKey, parseValue(rawValue, file, lineNumber))
	}
	closeList()

	let body = lines.slice(closing + 1).join('\n')
	body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
	return { values, body }
}

const RESERVED_PLAIN = /^(?:true|false|null|yes|no|on|off|~|[-+]?(?:\d[\d_]*)?\.?\d.*)$/i

/** A string the reader gets back unchanged without quotes, and YAML reads as the same string. */
function isPlainSafe(value: string): boolean {
	return (
		value.length > 0 &&
		value === value.trim() &&
		!/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
		!/: |\s#|:$/.test(value) &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
		!/[\u0000-\u001f\u007f]/.test(value) &&
		!RESERVED_PLAIN.test(value)
	)
}

function formatValue(value: FrontmatterJson): string {
	if (typeof value === 'string') return isPlainSafe(value) ? value : JSON.stringify(value)
	return JSON.stringify(value)
}

export interface MemoryFileFields {
	readonly name: string
	readonly description: string
	readonly type: MemoryType
	readonly status: MemoryStatus
	readonly createdAt: number
	readonly updatedAt: number
	readonly tags: readonly string[]
	readonly id: string
	readonly title: string
	readonly summary: string
	readonly format: 'text' | 'markdown' | 'json'
	readonly metadata?: Record<string, unknown>
}

/**
 * The file for one memory. Fields that repeat another are left out — a title
 * equal to the name, a summary equal to the description, the default format —
 * so an ordinary file carries the reference shape and nothing else.
 */
export function formatMemoryFile(fields: MemoryFileFields, body: string): string {
	const lines: string[] = ['---']
	const put = (key: MemoryFrontmatterKey, value: FrontmatterJson): void => {
		lines.push(`${key}: ${formatValue(value)}`)
	}
	put('name', fields.name)
	put('description', fields.description)
	put('type', fields.type)
	put('status', fields.status)
	put('createdAt', new Date(fields.createdAt).toISOString())
	put('updatedAt', new Date(fields.updatedAt).toISOString())
	if (fields.tags.length > 0) lines.push(`tags: ${JSON.stringify(fields.tags)}`)
	put('id', fields.id)
	if (fields.title !== fields.name) put('title', fields.title)
	if (fields.summary !== fields.description) put('summary', fields.summary)
	if (fields.format !== 'markdown') put('format', fields.format)
	if (fields.metadata !== undefined) lines.push(`metadata: ${JSON.stringify(fields.metadata)}`)
	lines.push('---', '', body, '')
	return lines.join('\n')
}
