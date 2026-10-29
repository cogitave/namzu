/**
 * `@file` mentions in a composed message. Typing `@src/auth.ts` inlines that
 * file's contents into the text sent to the model, while the visible
 * message keeps the readable `@path` token.
 *
 * `@"name (agent)"` (or `@agent-name`) names a sub-agent and `@server:address`
 * names a resource a connected tool server publishes; both are offered by the
 * same picker. Neither is inlined by the sync expansion: an agent mention adds
 * a short note that points the model at that agent, and a resource is read by
 * {@link attachMentionedResources}.
 *
 * Safety: only files resolving *inside* the working directory are inlined
 * (so `@/etc/passwd` or `@../secrets` are ignored, not exfiltrated), and each
 * file is capped so a huge file can't blow up the turn. Non-existent or
 * unreadable tokens are left as literal text.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { wrapUntrusted } from '@namzu/sdk'
import { readMentionFile } from './mention-file.js'

/**
 * What an unquoted `@path` may be made of: this class —
 * letters, digits and combining marks of any script, and `_ - . / \ ( ) [ ] ~ :`.
 * Trailing punctuation the class still captures is trimmed in `trimMention`.
 */
const PATH_CHARS = String.raw`\p{L}\p{N}\p{M}_\-./\\()[\]~:`
/** `@"a path with spaces.ts"`, or `@path`, either with an optional `#L10-20` suffix. */
const MENTION = new RegExp(String.raw`@(?:"([^"\n]+)"|([${PATH_CHARS}]+(?:#L\d+(?:-\d+)?)?))`, 'gu')
const MENTION_PATH = new RegExp(`^[${PATH_CHARS}]+$`, 'u')
const BEFORE_MENTION = new RegExp(`[${PATH_CHARS}]`, 'u')

const MAX_FILE_CHARS = 60_000
const MAX_MESSAGE_FILE_CHARS = 240_000
const MAX_MESSAGE_FILES = 32
/** Includes all resource framing, independent of the number of mentions. */
export const MAX_MESSAGE_RESOURCE_CHARS = 30_000
const MAX_MESSAGE_RESOURCES = 32
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

/** What a mention can point at besides a file. */
export interface MentionExtra {
	readonly kind: 'agent' | 'resource'
	/** What follows the `@`: `reviewer (agent)` or `server:address`. */
	readonly label: string
	readonly description?: string
}

/** One row of the picker: a file, an agent or a resource. */
export interface MentionSuggestion {
	readonly kind: 'file' | 'agent' | 'resource'
	/** What the row shows after `@`. */
	readonly label: string
	/** The complete token written into the composer, `@` included. */
	readonly insert: string
	readonly description?: string
}

/** What a sent message may name besides files. */
export interface KnownMentions {
	/** Names a sub-agent can be picked by. */
	readonly agents?: ReadonlySet<string>
	/** Names of the connected tool servers. */
	readonly servers?: ReadonlySet<string>
}

/** One mentioned resource, to be read by {@link attachMentionedResources}. */
export interface ResourceReference {
	readonly server: string
	readonly uri: string
}

export function agentMention(name: string): MentionExtra {
	return { kind: 'agent', label: `${name} (agent)` }
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

function isMentionableLabel(label: string): boolean {
	return label.length > 0 && !/["\n\r]/u.test(label)
}

function rankExtra(extra: MentionExtra, query: string): readonly [number, number, string] | null {
	const label = extra.label.toLowerCase()
	if (query.length === 0) return [0, label.length, label]
	if (label.startsWith(query)) return [0, label.length, label]
	// A resource reads `server:address`, an agent `name (agent)`: the part that
	// names it, after the colon for a resource.
	const name = extra.kind === 'resource' ? label.slice(label.indexOf(':') + 1) : label
	if (name.startsWith(query)) return [1, label.length, label]
	if (label.includes(query)) return [3, label.length, label]
	if (extra.description?.toLowerCase().includes(query)) return [5, label.length, label]
	if (subsequenceMatch(label, query)) return [4, label.length, label]
	return null
}

/**
 * The picker rows for the token being typed: files, sub-agents and resources
 * in one list, best match first. With nothing typed yet the files come first
 * and a few agents and resources are kept in the list so they can be found.
 */
export function matchMentionSuggestions(
	query: string,
	files: readonly string[],
	extras: readonly MentionExtra[] = [],
	limit = 100,
): readonly MentionSuggestion[] {
	const normalizedQuery = query.toLowerCase()
	const usable = extras.filter((extra) => isMentionableLabel(extra.label))
	const fileRow = (path: string): MentionSuggestion => ({
		kind: 'file',
		label: path,
		insert: mentionText(path),
	})
	const extraRow = (extra: MentionExtra): MentionSuggestion => ({
		kind: extra.kind,
		label: extra.label,
		insert: mentionText(extra.label),
		...(extra.description ? { description: extra.description } : {}),
	})
	if (normalizedQuery.length === 0) {
		const kept = usable.slice(0, Math.min(usable.length, Math.floor(limit / 4)))
		return [
			...matchMentionableFiles('', files, Math.max(0, limit - kept.length)).map(fileRow),
			...kept.map(extraRow),
		]
	}
	const rows: Array<{ row: MentionSuggestion; rank: readonly [number, number, string] }> = []
	for (const path of files) {
		const rank = mentionRank(path, normalizedQuery)
		if (rank !== null) rows.push({ row: fileRow(path), rank })
	}
	for (const extra of usable) {
		const rank = rankExtra(extra, normalizedQuery)
		if (rank !== null) rows.push({ row: extraRow(extra), rank })
	}
	return rows
		.sort(
			(a, b) =>
				a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2].localeCompare(b.rank[2]),
		)
		.slice(0, Math.max(0, limit))
		.map(({ row }) => row)
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
	/**
	 * The `<file>` blocks alone, when there are any. They are file contents,
	 * not the operator's words, so a host that records provenance sends them
	 * as their own message instead of inside the operator's.
	 */
	readonly inlined?: string
	/** Sub-agents the message names, each once. */
	readonly agents?: readonly string[]
	/** Resources the message names that {@link attachMentionedResources} reads. */
	readonly resources?: readonly ResourceReference[]
}

/**
 * Expand `@path` tokens in `text`. `readFile` is injectable for tests; the
 * default reads from disk, scoped to `cwd` and size-capped.
 */
export function expandFileMentions(
	text: string,
	cwd: string,
	readFile?: (relPath: string) => string | null,
	known: KnownMentions = {},
): ExpandedMessage {
	const attached: string[] = []
	const blocks: string[] = []
	const seen = new Set<string>()
	const agents: string[] = []
	const resources: ResourceReference[] = []
	const budget = { bytes: 16 * 1024 * 1024 }
	let remainingChars = MAX_MESSAGE_FILE_CHARS
	let attemptedFiles = 0
	for (const match of text.matchAll(MENTION)) {
		const quoted = match[1] !== undefined
		const token = match[1] ?? match[2] ?? ''
		const target = classifyMention(quoted ? token : trimMention(token), quoted, known)
		if (target?.kind === 'agent') {
			if (!agents.includes(target.name)) agents.push(target.name)
			continue
		}
		if (target?.kind === 'resource') {
			if (!resources.some((r) => r.server === target.server && r.uri === target.uri))
				resources.push({ server: target.server, uri: target.uri })
			continue
		}
		const parsed = parseMention(token, quoted)
		if (parsed === null) continue
		const label = parsed.range ? `${parsed.path}#L${rangeLabel(parsed.range)}` : parsed.path
		if (seen.has(label)) continue
		seen.add(label)
		if (remainingChars <= 0 || attemptedFiles >= MAX_MESSAGE_FILES || budget.bytes <= 0) continue
		attemptedFiles++
		const maxChars = Math.min(MAX_FILE_CHARS, remainingChars)
		let content: string | null
		if (readFile) {
			// Trusted test adapters return strings; production never allocates a whole file.
			try {
				const whole = readFile(parsed.path)
				content = whole === null ? null : parsed.range ? lineRange(whole, parsed.range) : whole
			} catch {
				content = null
			}
		} else content = readMentionFile(cwd, parsed.path, parsed.range, maxChars, budget)
		if (content === null) continue
		const body =
			content.length > maxChars ? `${content.slice(0, maxChars)}\n… (truncated)` : content
		remainingChars -= body.length
		blocks.push(
			parsed.range
				? `<file path="${parsed.path}" lines="${rangeLabel(parsed.range)}">\n${body}\n</file>`
				: `<file path="${parsed.path}">\n${body}\n</file>`,
		)
		attached.push(label)
	}
	for (const name of agents) blocks.push(agentNote(name))
	const extra = {
		...(agents.length > 0 ? { agents } : {}),
		...(resources.length > 0 ? { resources } : {}),
	}
	if (blocks.length === 0) return { sendText: text, attached: [], ...extra }
	const inlined = blocks.join('\n\n')
	return { sendText: `${text}\n\n${inlined}`, attached, inlined, ...extra }
}

type MentionTarget =
	| { readonly kind: 'agent'; readonly name: string }
	| { readonly kind: 'resource'; readonly server: string; readonly uri: string }

/**
 * Whether a token names a known sub-agent (`"name (agent)"` or `agent-name`)
 * or a resource of a connected server (`server:address`). Anything else is a
 * file path, and a name or server that is not connected stays one too.
 */
function classifyMention(
	body: string,
	quoted: boolean,
	known: KnownMentions,
): MentionTarget | null {
	if (quoted) {
		const agent = /^(.+) \(agent\)$/u.exec(body)
		if (agent && known.agents?.has(agent[1] as string))
			return { kind: 'agent', name: agent[1] as string }
	} else if (body.startsWith('agent-') && known.agents?.has(body.slice(6))) {
		return { kind: 'agent', name: body.slice(6) }
	}
	const colon = body.indexOf(':')
	if (colon > 0 && colon < body.length - 1 && known.servers?.has(body.slice(0, colon)))
		return { kind: 'resource', server: body.slice(0, colon), uri: body.slice(colon + 1) }
	return null
}

/** Tells the model which agent the person named and how to reach it. */
function agentNote(name: string): string {
	return `<mentioned-agent name="${name}">\nThe person named this agent. Give it the part of the request that fits it by calling the Agent tool with subagent_type "${name}".\n</mentioned-agent>`
}

/**
 * Read the resources a message names and add them beside the file contents.
 * A resource that cannot be read is left out, and the message goes on without
 * it. The text comes from a remote server, so each block carries a marker that
 * is new for every message and a line saying so.
 */
export async function attachMentionedResources(
	expanded: ExpandedMessage,
	original: string,
	read: (server: string, uri: string) => Promise<string | null>,
	maxChars = MAX_FILE_CHARS,
): Promise<ExpandedMessage> {
	const wanted = expanded.resources ?? []
	if (wanted.length === 0) return expanded
	const marker = randomBytes(6).toString('hex')
	const blocks: string[] = []
	const attached = [...expanded.attached]
	// Reserve room for the SDK's nonce-bound envelope, separators and a final
	// omission notice. Never truncate an already-rendered closing delimiter.
	let remaining =
		Math.min(
			MAX_MESSAGE_RESOURCE_CHARS,
			Math.max(0, MAX_MESSAGE_FILE_CHARS - (expanded.inlined?.length ?? 0)),
		) - 1_500
	const escapeAttribute = (value: string) =>
		value
			.replaceAll('&', '&amp;')
			.replaceAll('"', '&quot;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
	const perResource = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : MAX_FILE_CHARS
	let omitted = false
	let attempts = 0
	for (const { server, uri } of wanted) {
		if (remaining <= 200 || attempts >= MAX_MESSAGE_RESOURCES) {
			omitted = true
			break
		}
		// A very large identity cannot consume the attachment budget or cause a
		// read whose provenance would not fit. Bound before escaping allocates.
		if (server.length + uri.length > remaining / 6) {
			omitted = true
			continue
		}
		const open = `<resource-${marker} server="${escapeAttribute(server)}" uri="${escapeAttribute(uri)}">\n`
		const close = `\n</resource-${marker}>`
		const available = Math.max(
			0,
			Math.min(perResource, remaining - open.length - close.length - 32),
		)
		if (available <= 0) {
			omitted = true
			break
		}
		attempts++
		const content = await read(server, uri).catch(() => null)
		if (content === null) continue
		const body =
			content.length > available ? `${content.slice(0, available)}\n… (truncated)` : content
		const block = open + body + close
		remaining -= block.length + 2
		blocks.push(block)
		attached.push(`${server}:${uri}`)
	}
	if (blocks.length === 0) return expanded
	if (omitted)
		blocks.push('[Additional MCP resource attachments omitted: aggregate limit reached.]')
	const framed = wrapUntrusted(
		{
			kind: 'mcp-resources',
			provenance:
				'The text came from the tool server named in each resource block, not the person.',
		},
		blocks.join('\n\n'),
	)
	const inlined = [expanded.inlined, framed].filter((part) => part !== undefined).join('\n\n')
	return { ...expanded, sendText: `${original}\n\n${inlined}`, attached, inlined }
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
 * rule: `#L10` is one line, `#L10-20` an inclusive range,
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
