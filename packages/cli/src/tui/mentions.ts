/**
 * `@file` mentions in a composed message. Typing `@src/auth.ts` inlines that
 * file's contents into the text sent to the model, while the visible
 * message keeps the readable `@path` token.
 *
 * Safety: only files resolving *inside* the working directory are inlined
 * (so `@/etc/passwd` or `@../secrets` are ignored, not exfiltrated), and each
 * file is capped so a huge file can't blow up the turn. Non-existent or
 * unreadable tokens are left as literal text.
 */

import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

/**
 * What an unquoted `@path` may be made of: the reference terminal's class —
 * letters, digits and combining marks of any script, and `_ - . / \ ( ) [ ] ~ :`.
 * Trailing punctuation the class still captures is trimmed in `trimMention`.
 */
const PATH_CHARS = String.raw`\p{L}\p{N}\p{M}_\-./\\()[\]~:`
/** `@"a path with spaces.ts"`, or `@path`, either with an optional `#L10-20` suffix. */
const MENTION = new RegExp(String.raw`@(?:"([^"\n]+)"|([${PATH_CHARS}]+(?:#L\d+(?:-\d+)?)?))`, 'gu')
const MENTION_PATH = new RegExp(`^[${PATH_CHARS}]+$`, 'u')
const BEFORE_MENTION = new RegExp(`[${PATH_CHARS}]`, 'u')

const MAX_FILE_CHARS = 60_000
const MAX_MENTION_FILES = 20_000
const FILE_LIST_TIMEOUT_MS = 5_000
const run = promisify(execFile)

export interface ActiveFileMention {
	/** Inclusive `@` position in the complete composer value. */
	readonly start: number
	/** Exclusive end of the token, equal to the current cursor. */
	readonly end: number
	readonly query: string
}

/**
 * The file token currently ending at the cursor, excluding email-like text.
 *
 * A token that opens with `@"` is a quoted path: it may hold spaces and runs to
 * the cursor, so `@"my fi` completes against `my fi`. The query never carries
 * the quote.
 */
export function activeFileMention(text: string, cursor: number): ActiveFileMention | null {
	const prefix = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
	const quoted = /(?:^|\s)@"([^"\n]*)$/u.exec(prefix)
	if (quoted) {
		const query = quoted[1] ?? ''
		return { start: prefix.length - query.length - 2, end: prefix.length, query }
	}
	const start = prefix.lastIndexOf('@')
	if (start < 0) return null
	const query = prefix.slice(start + 1)
	if (query.length > 0 && !MENTION_PATH.test(query)) return null
	const before = start > 0 ? prefix[start - 1] : undefined
	if (before !== undefined && BEFORE_MENTION.test(before)) return null
	return { start, end: prefix.length, query }
}

/** The text that completes a mention of `path`: quoted when it holds a space. */
export function mentionText(path: string): string {
	return MENTION_PATH.test(path) ? `@${path}` : `@"${path}"`
}

function isMentionablePath(path: string): boolean {
	// A quote or a line break cannot be written inside `@"..."`, so such a path
	// cannot be mentioned at all.
	if (path.length === 0 || path.startsWith('/') || /["\n\r]/u.test(path)) return false
	return !path.split('/').some((part) => part === '' || part === '.' || part === '..')
}

/**
 * List tracked and unignored project files once per hydrated TUI session.
 *
 * The command is argument-vector based (no shell), bounded by time, output and
 * result count, and returns no candidates outside a repository. Exact `@path`
 * input keeps working outside Git; only the convenience picker is absent.
 */
export async function listMentionableFiles(
	cwd: string,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	try {
		const { stdout } = await run(
			'git',
			['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'],
			{
				cwd,
				signal,
				timeout: FILE_LIST_TIMEOUT_MS,
				maxBuffer: 2 * 1024 * 1024,
			},
		)
		const files: string[] = []
		for (const path of stdout.split('\0')) {
			if (!isMentionablePath(path)) continue
			files.push(path)
			if (files.length === MAX_MENTION_FILES) break
		}
		return files
	} catch {
		return []
	}
}

function subsequenceMatch(candidate: string, query: string): boolean {
	let index = 0
	for (const character of candidate) {
		if (character === query[index]) index += 1
		if (index === query.length) return true
	}
	return query.length === 0
}

function mentionRank(path: string, query: string): readonly [number, number, string] | null {
	if (query.length === 0) return [0, path.length, path]
	const normalized = path.toLowerCase()
	const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
	if (basename.startsWith(query)) return [0, path.length, path]
	if (normalized.startsWith(query)) return [1, path.length, path]
	if (basename.includes(query)) return [2, path.length, path]
	if (normalized.includes(query)) return [3, path.length, path]
	if (subsequenceMatch(normalized, query)) return [4, path.length, path]
	return null
}

/** Deterministic fuzzy file matches for the active token, bounded for rendering. */
export function matchMentionableFiles(
	query: string,
	files: readonly string[],
	limit = 100,
): readonly string[] {
	const normalizedQuery = query.toLowerCase()
	return files
		.map((path) => ({ path, rank: mentionRank(path, normalizedQuery) }))
		.filter(
			(candidate): candidate is { path: string; rank: readonly [number, number, string] } =>
				candidate.rank !== null,
		)
		.sort(
			(a, b) =>
				a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2].localeCompare(b.rank[2]),
		)
		.slice(0, Math.max(0, limit))
		.map(({ path }) => path)
}

export interface ExpandedMessage {
	/** Text to send to the model (original + inlined `<file>` blocks). */
	readonly sendText: string
	/** Relative paths that were inlined (for a UI affordance). */
	readonly attached: readonly string[]
}

/**
 * Expand `@path` tokens in `text`. `readFile` is injectable for tests; the
 * default reads from disk, scoped to `cwd` and size-capped.
 */
export function expandFileMentions(
	text: string,
	cwd: string,
	readFile: (relPath: string) => string | null = (rel) => safeReadInCwd(cwd, rel),
): ExpandedMessage {
	const attached: string[] = []
	const blocks: string[] = []
	const seen = new Set<string>()
	for (const match of text.matchAll(MENTION)) {
		const parsed = parseMention(match[1] ?? match[2] ?? '', match[1] !== undefined)
		if (parsed === null) continue
		const label = parsed.range ? `${parsed.path}#L${rangeLabel(parsed.range)}` : parsed.path
		if (seen.has(label)) continue
		seen.add(label)
		const whole = readFile(parsed.path)
		if (whole === null) continue
		const content = parsed.range ? lineRange(whole, parsed.range) : whole
		const body =
			content.length > MAX_FILE_CHARS
				? `${content.slice(0, MAX_FILE_CHARS)}\n… (truncated)`
				: content
		blocks.push(
			parsed.range
				? `<file path="${parsed.path}" lines="${rangeLabel(parsed.range)}">\n${body}\n</file>`
				: `<file path="${parsed.path}">\n${body}\n</file>`,
		)
		attached.push(label)
	}
	if (blocks.length === 0) return { sendText: text, attached: [] }
	return { sendText: `${text}\n\n${blocks.join('\n\n')}`, attached }
}

interface LineRange {
	/** 1-based, inclusive. */
	readonly start: number
	readonly end: number
}

interface ParsedMention {
	readonly path: string
	readonly range?: LineRange
}

function rangeLabel(range: LineRange): string {
	return range.end === range.start ? `${range.start}` : `${range.start}-${range.end}`
}

/**
 * Split one matched token into a path and an optional `#L10-20` range, the
 * reference terminal's rule: `#L10` is one line, `#L10-20` an inclusive range,
 * and the range is the lines sent. A range written backwards, or starting at
 * line 0, is not a range and the path is read whole.
 */
function parseMention(token: string, quoted: boolean): ParsedMention | null {
	let body = quoted ? token : trimMention(token)
	let range: LineRange | undefined
	const suffix = /^(.+?)#L(\d+)(?:-(\d+))?$/u.exec(body)
	if (suffix) {
		const start = Number(suffix[2])
		const end = suffix[3] === undefined ? start : Number(suffix[3])
		if (start >= 1 && end >= start) {
			body = suffix[1] as string
			range = { start, end }
		} else if (start >= 1 || end >= 1) {
			body = suffix[1] as string
		}
	}
	if (body.length === 0) return null
	return range ? { path: body, range } : { path: body }
}

/**
 * Drop what trails an unquoted token without being part of the name: sentence
 * punctuation, and a closing `)` or `]` with no opener inside the token, so
 * `(see @a.ts)` mentions `a.ts`.
 */
function trimMention(token: string): string {
	let out = token
	for (;;) {
		const last = out[out.length - 1]
		if (last === undefined) return out
		if (/[.,;:!?]/u.test(last)) out = out.slice(0, -1)
		else if (last === ')' && !out.includes('(')) out = out.slice(0, -1)
		else if (last === ']' && !out.includes('[')) out = out.slice(0, -1)
		else return out
	}
}

function lineRange(content: string, range: LineRange): string {
	return content
		.split('\n')
		.slice(range.start - 1, range.end)
		.join('\n')
}

function safeReadInCwd(cwd: string, rel: string): string | null {
	try {
		const root = realpathSync(resolve(cwd))
		const abs = realpathSync(resolve(root, rel))
		if (abs !== root && !abs.startsWith(root + sep)) return null
		if (!statSync(abs).isFile()) return null
		return readFileSync(abs, 'utf8')
	} catch {
		return null
	}
}
