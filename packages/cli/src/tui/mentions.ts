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

/** Path-ish characters only, so `@a.ts,` or `@a.ts)` don't swallow punctuation. */
const MENTION = /@([\w./~-]+)/g
const MENTION_PATH = /^[\w./~-]+$/u

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

/** The file token currently ending at the cursor, excluding email-like text. */
export function activeFileMention(text: string, cursor: number): ActiveFileMention | null {
	const prefix = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
	const start = prefix.lastIndexOf('@')
	if (start < 0) return null
	const query = prefix.slice(start + 1)
	if (query.length > 0 && !MENTION_PATH.test(query)) return null
	const before = start > 0 ? prefix[start - 1] : undefined
	if (before !== undefined && /[\w./~-]/u.test(before)) return null
	return { start, end: prefix.length, query }
}

function isMentionablePath(path: string): boolean {
	if (path.length === 0 || path.startsWith('/') || !MENTION_PATH.test(path)) return false
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
	const tokens = text.match(MENTION)
	if (!tokens) return { sendText: text, attached: [] }
	const attached: string[] = []
	const blocks: string[] = []
	const seen = new Set<string>()
	for (const tok of tokens) {
		// Drop trailing sentence punctuation the path-char class still captured
		// (e.g. the final `.` in "see @b.ts.").
		const rel = tok.slice(1).replace(/[.,;:!?]+$/, '')
		if (rel.length === 0 || seen.has(rel)) continue
		seen.add(rel)
		const content = readFile(rel)
		if (content === null) continue
		blocks.push(`<file path="${rel}">\n${content}\n</file>`)
		attached.push(rel)
	}
	if (blocks.length === 0) return { sendText: text, attached: [] }
	return { sendText: `${text}\n\n${blocks.join('\n\n')}`, attached }
}

function safeReadInCwd(cwd: string, rel: string): string | null {
	try {
		const root = realpathSync(resolve(cwd))
		const abs = realpathSync(resolve(root, rel))
		if (abs !== root && !abs.startsWith(root + sep)) return null
		if (!statSync(abs).isFile()) return null
		const raw = readFileSync(abs, 'utf8')
		return raw.length > MAX_FILE_CHARS ? `${raw.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : raw
	} catch {
		return null
	}
}
