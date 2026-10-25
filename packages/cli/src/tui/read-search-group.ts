/**
 * Consecutive reads, searches, directory listings and connector calls fold
 * into one line that counts them, "Searched for 2 patterns, read 3 files",
 * instead of one row per call.
 *
 * Everything here is pure: the live run, a resumed conversation and the tests
 * all fold through the same reducer, and the clock is a parameter.
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** What a call is, for the fold. */
export type FoldKind = 'read' | 'search' | 'list' | 'mcp'

/** One call, as the fold sees it. */
export interface FoldOp {
	readonly kind: FoldKind
	/** Reads count distinct keys: the same file read twice is one file. */
	readonly key?: string
	/** The connector a call went to. */
	readonly label?: string
	/** What to show under the line while the call runs. */
	readonly hint?: string
}

/** The running tally of one group. Immutable: every step returns a new one. */
export interface GroupState {
	readonly readKeys: readonly string[]
	/** Reads that name no file (a read-only shell command). */
	readonly anonymousReads: number
	readonly searches: number
	readonly lists: number
	readonly mcpCalls: number
	/** Connectors, in the order they were first called. */
	readonly mcpLabels: readonly string[]
	/** The hint on screen, and the newest one held back until the interval ends. */
	readonly hintShown?: string
	readonly hintShownAt?: number
	readonly hintQueued?: string
}

export const EMPTY_GROUP: GroupState = {
	readKeys: [],
	anonymousReads: 0,
	searches: 0,
	lists: 0,
	mcpCalls: 0,
	mcpLabels: [],
}

/** The shown hint changes at most this often; the first one is immediate. */
export const HINT_INTERVAL_MS = 700
/** A hint is cut at this many characters. */
export const HINT_MAX_CHARS = 300

function cap(text: string): string {
	return text.length > HINT_MAX_CHARS ? `${text.slice(0, HINT_MAX_CHARS - 1)}…` : text
}

/** Add one call. Counts only ever go up, so a failed call never makes a number drop. */
export function foldOp(state: GroupState, op: FoldOp, now: number): GroupState {
	let next: GroupState = state
	switch (op.kind) {
		case 'read':
			next =
				op.key === undefined
					? { ...state, anonymousReads: state.anonymousReads + 1 }
					: state.readKeys.includes(op.key)
						? state
						: { ...state, readKeys: [...state.readKeys, op.key] }
			break
		case 'search':
			next = { ...state, searches: state.searches + 1 }
			break
		case 'list':
			next = { ...state, lists: state.lists + 1 }
			break
		case 'mcp':
			next = {
				...state,
				mcpCalls: state.mcpCalls + 1,
				mcpLabels:
					op.label === undefined || state.mcpLabels.includes(op.label)
						? state.mcpLabels
						: [...state.mcpLabels, op.label],
			}
			break
	}
	return op.hint === undefined ? next : withHint(next, cap(op.hint), now)
}

function withHint(state: GroupState, hint: string, now: number): GroupState {
	if (state.hintShownAt === undefined || now - state.hintShownAt >= HINT_INTERVAL_MS) {
		const { hintQueued: _queued, ...rest } = state
		return { ...rest, hintShown: hint, hintShownAt: now }
	}
	return { ...state, hintQueued: hint }
}

/** The hint to draw at `now`: the shown one, or the held one once its interval has passed. */
export function visibleHint(state: GroupState, now: number): string | undefined {
	if (
		state.hintQueued !== undefined &&
		state.hintShownAt !== undefined &&
		now - state.hintShownAt >= HINT_INTERVAL_MS
	) {
		return state.hintQueued
	}
	return state.hintShown
}

/** Two groups that sat next to each other, as one. Hints belong to a live run and are dropped. */
export function mergeGroups(a: GroupState, b: GroupState): GroupState {
	return {
		readKeys: [...a.readKeys, ...b.readKeys.filter((key) => !a.readKeys.includes(key))],
		anonymousReads: a.anonymousReads + b.anonymousReads,
		searches: a.searches + b.searches,
		lists: a.lists + b.lists,
		mcpCalls: a.mcpCalls + b.mcpCalls,
		mcpLabels: [...a.mcpLabels, ...b.mcpLabels.filter((label) => !a.mcpLabels.includes(label))],
	}
}

/** One clause of the line; `count` is drawn bold. */
export interface GroupPart {
	readonly verb: string
	readonly count?: number
	readonly noun?: string
	/** Text between the verb and the count, as the connector names. */
	readonly names?: string
	readonly suffix?: string
}

const WORDS = {
	search: { live: 'searching for', done: 'searched for', one: 'pattern', many: 'patterns' },
	read: { live: 'reading', done: 'read', one: 'file', many: 'files' },
	list: { live: 'listing', done: 'listed', one: 'directory', many: 'directories' },
	mcp: { live: 'calling', done: 'called' },
} as const

/** The clauses, in the order the line prints them. Only counts above zero appear. */
export function groupParts(state: GroupState, live: boolean): readonly GroupPart[] {
	const parts: GroupPart[] = []
	if (state.searches > 0) {
		const w = WORDS.search
		parts.push({
			verb: live ? w.live : w.done,
			count: state.searches,
			noun: state.searches === 1 ? w.one : w.many,
		})
	}
	const reads = state.readKeys.length + state.anonymousReads
	if (reads > 0) {
		const w = WORDS.read
		parts.push({ verb: live ? w.live : w.done, count: reads, noun: reads === 1 ? w.one : w.many })
	}
	if (state.lists > 0) {
		const w = WORDS.list
		parts.push({
			verb: live ? w.live : w.done,
			count: state.lists,
			noun: state.lists === 1 ? w.one : w.many,
		})
	}
	if (state.mcpCalls > 0) {
		const w = WORDS.mcp
		const names = state.mcpLabels.length > 0 ? state.mcpLabels.join(', ') : 'MCP'
		parts.push({
			verb: live ? w.live : w.done,
			...(names.length > 0 ? { names } : {}),
			...(state.mcpCalls > 1 ? { count: state.mcpCalls, suffix: 'times' } : {}),
		})
	}
	return parts
}

/** A run of text and whether it is a figure. */
export interface GroupSegment {
	readonly text: string
	readonly bold: boolean
}

/**
 * The line as segments, the figures marked for bold. The first letter is
 * capital; a live line ends in an ellipsis. `leading` is for clauses that
 * come before the counts.
 */
export function groupSegments(
	state: GroupState,
	live: boolean,
	leading: readonly GroupPart[] = [],
): readonly GroupSegment[] {
	const segments: GroupSegment[] = []
	const parts = [...leading, ...groupParts(state, live)]
	parts.forEach((part, index) => {
		if (index > 0) segments.push({ text: ', ', bold: false })
		const verb = index === 0 ? part.verb.charAt(0).toUpperCase() + part.verb.slice(1) : part.verb
		const lead = [verb, part.names].filter((word) => word !== undefined && word.length > 0)
		segments.push({ text: lead.join(' '), bold: false })
		if (part.count !== undefined) {
			segments.push({ text: ' ', bold: false })
			segments.push({ text: String(part.count), bold: true })
			const tail = part.noun ?? part.suffix
			if (tail) segments.push({ text: ` ${tail}`, bold: false })
		}
	})
	if (live && parts.length > 0) segments.push({ text: '…', bold: false })
	return segments
}

/** The line as plain text. */
export function groupText(state: GroupState, live: boolean): string {
	return groupSegments(state, live)
		.map((segment) => segment.text)
		.join('')
}

// ---------------------------------------------------------------------------
// What a call is
// ---------------------------------------------------------------------------

const SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])
const READ_COMMANDS = new Set([
	'cat',
	'head',
	'tail',
	'less',
	'more',
	'wc',
	'stat',
	'file',
	'strings',
	'jq',
	'awk',
	'cut',
	'sort',
	'uniq',
	'tr',
])
const LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
const NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])

const SAFE_REDIRECT = /^(?:>&\d|&?>>?\s*\/dev\/null)(?=\s|$|[;|&])/

type ShellClass = 'search' | 'list' | 'read'

/**
 * Cut a command line at its unquoted `|`, `||`, `&&`, `;`, and refuse
 * anything that could write or run something else: a redirect (except to /dev/null or between descriptors), a
 * substitution, a background `&`, a subshell, a here-document. Undefined
 * means the line is not one this fold may hide.
 */
function shellSegments(command: string): readonly string[] | undefined {
	const segments: string[] = []
	let current = ''
	let quote: '"' | "'" | null = null
	for (let i = 0; i < command.length; i++) {
		const ch = command.charAt(i)
		const next = command.charAt(i + 1)
		if (quote === "'") {
			if (ch === "'") quote = null
			current += ch
			continue
		}
		if (ch === '\\') {
			current += ch + next
			i += 1
			continue
		}
		if (ch === '`' || (ch === '$' && next === '(')) return undefined
		if (quote === '"') {
			if (ch === '"') quote = null
			current += ch
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			current += ch
			continue
		}
		// Harmless redirects: fd to fd (`2>&1`) and anything to /dev/null.
		if (ch === '>' || ch === '&') {
			const safe = SAFE_REDIRECT.exec(command.slice(i))
			if (safe) {
				current += safe[0]
				i += safe[0].length - 1
				continue
			}
		}
		if (ch === '>' || ch === '<' || ch === '(' || ch === ')' || ch === '{' || ch === '}')
			return undefined
		if (ch === '&' && next !== '&') return undefined
		if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
			if ((ch === '|' || ch === '&') && next === ch) i += 1
			segments.push(current)
			current = ''
			continue
		}
		current += ch
	}
	if (quote !== null) return undefined
	segments.push(current)
	return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/** Options that make a search or sort command change or run something. */
function writesOrRuns(word: string, segment: string): boolean {
	if (word === 'find')
		return /(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)(\s|$)/.test(segment)
	if (word === 'sort')
		return /(^|\s)(-o|--output)(\s|=|$)/.test(segment) || /(^|\s)-\w*o\b/.test(segment)
	if (word === 'awk') return /system\s*\(|getline|print\s*>|\|&/.test(segment)
	return false
}

/**
 * Whether a shell command only looks: every piece is a known search, read or
 * list command. The class is the first that applies of list, search, read.
 * A line of nothing but echo/printf/true is not one.
 */
export function classifyShell(command: string): ShellClass | undefined {
	const segments = shellSegments(command)
	if (!segments || segments.length === 0) return undefined
	let search = false
	let list = false
	let read = false
	for (const segment of segments) {
		const word = segment.split(/\s+/)[0] ?? ''
		if (NEUTRAL_COMMANDS.has(word)) continue
		if (writesOrRuns(word, segment)) return undefined
		if (SEARCH_COMMANDS.has(word)) search = true
		else if (LIST_COMMANDS.has(word)) list = true
		else if (READ_COMMANDS.has(word)) read = true
		else return undefined
	}
	if (list) return 'list'
	if (search) return 'search'
	if (read) return 'read'
	return undefined
}

/** A path as a person would say it: from the working folder, else from home, else whole. */
export function displayPath(path: string, cwd: string | undefined): string {
	const abs = cwd && !isAbsolute(path) ? resolve(cwd, path) : path
	if (cwd) {
		const rel = relative(cwd, abs)
		if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return rel
	}
	const home = homedir()
	if (home && (abs === home || abs.startsWith(home + sep))) return `~${abs.slice(home.length)}`
	return abs
}

export interface FoldCall {
	readonly toolName: string
	readonly input: unknown
	readonly cwd?: string
	/** The call's view said it explores. */
	readonly exploration?: boolean
	readonly label?: string
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function mcpServer(toolName: string): string | undefined {
	if (!toolName.startsWith('mcp__')) return undefined
	const server = toolName.slice('mcp__'.length).split('__')[0]
	return server || undefined
}

/** What a call is to the fold, or undefined when it stays a row of its own. */
export function classifyCall(call: FoldCall): FoldOp | undefined {
	const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<
		string,
		unknown
	>
	const name = call.toolName
	const server = mcpServer(name)
	if (server !== undefined) {
		const query = text(input.query)
		return {
			kind: 'mcp',
			label: server,
			...(query ? { hint: `"${query}"` } : {}),
		}
	}
	switch (name) {
		case 'read':
		case 'view_image': {
			const path = text(input.path)
			if (!path) return undefined
			const shown = displayPath(path, call.cwd)
			return { kind: 'read', key: shown, hint: shown }
		}
		case 'grep':
		case 'glob': {
			const pattern = text(input.pattern)
			return { kind: 'search', ...(pattern ? { hint: `"${pattern}"` } : {}) }
		}
		case 'ls': {
			const path = text(input.path)
			return { kind: 'list', ...(path ? { hint: displayPath(path, call.cwd) } : {}) }
		}
		case 'bash': {
			const command = text(input.command)
			if (!command || input.run_in_background === true) return undefined
			const kind = classifyShell(command)
			if (!kind) return undefined
			const lines = command
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
			return { kind, hint: `$ ${lines.join('\n')}` }
		}
		default:
			// A view that says it explores, from a tool this module does not know.
			return call.exploration && call.label ? { kind: 'read', key: call.label } : undefined
	}
}
