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

import stringWidth from 'string-width'

import type { ShellOutput } from './shell-cell.js'

/** What a call is, for the fold. */
export type FoldKind = 'read' | 'search' | 'list' | 'mcp' | 'run'

/**
 * A command that ended well, as its own row would draw it: the header and the
 * output hung under it. A group that holds this one command and nothing else is
 * drawn as that row.
 */
export interface CommandCell {
	readonly header: string
	readonly shell: ShellOutput
}

/** One call, as the fold sees it. */
export interface FoldOp {
	readonly kind: FoldKind
	/** Reads count distinct keys: the same file read twice is one file. */
	readonly key?: string
	/** The connector a call went to. */
	readonly label?: string
	/** What to show under the line while the call runs. */
	readonly hint?: string
	/** A command that ended well: the command line. */
	readonly command?: string
	/** A command that ended well: its row, for the group that holds only it. */
	readonly cell?: CommandCell
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
	/** Shell commands that ended well and are not look-only, oldest first. */
	readonly commands: readonly string[]
	/** The row of the one command, while the group holds that and nothing else. */
	readonly cell?: CommandCell
	/** The newest call's hint, drawn under the line while the group is open. */
	readonly hintShown?: string
}

export const EMPTY_GROUP: GroupState = {
	readKeys: [],
	anonymousReads: 0,
	searches: 0,
	lists: 0,
	mcpCalls: 0,
	mcpLabels: [],
	commands: [],
}

/** A hint is cut at this many characters. */
export const HINT_MAX_CHARS = 300

function cap(text: string): string {
	return text.length > HINT_MAX_CHARS ? `${text.slice(0, HINT_MAX_CHARS - 1)}…` : text
}

/** Add one call. Counts only ever go up, so a failed call never makes a number drop. */
export function foldOp(state: GroupState, op: FoldOp): GroupState {
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
		case 'run':
			next = {
				...state,
				commands: [...state.commands, op.command ?? ''],
				...(op.cell ? { cell: op.cell } : {}),
			}
			break
	}
	next = aloneOrNot(next)
	return op.hint === undefined ? next : withHint(next, cap(op.hint))
}

/** Whether the group holds exactly one command and no other call. */
function holdsOnlyOneCommand(state: GroupState): boolean {
	return (
		state.commands.length === 1 &&
		state.readKeys.length + state.anonymousReads + state.searches + state.lists + state.mcpCalls ===
			0
	)
}

/** The command's own row is kept only while it is the whole group. */
function aloneOrNot(state: GroupState): GroupState {
	if (state.cell === undefined || holdsOnlyOneCommand(state)) return state
	const { cell: _cell, ...rest } = state
	return rest
}

/** A group that is one command and nothing else: drawn as that command's row. */
export function isOneCommand(state: GroupState | undefined): state is GroupState & {
	readonly cell: CommandCell
} {
	return state?.cell !== undefined && holdsOnlyOneCommand(state)
}

/** The hint is the newest call's, shown as that call starts and kept until the next one starts. */
function withHint(state: GroupState, hint: string): GroupState {
	return { ...state, hintShown: hint }
}

/** The hint to draw: the latest item the open group has started. */
export function visibleHint(state: GroupState): string | undefined {
	return state.hintShown
}

/** The rows of the hint under a live group, for the height estimate. */
export function hintRows(state: GroupState): readonly string[] {
	return state.hintShown === undefined ? [] : state.hintShown.split('\n')
}

/** Two groups that sat next to each other, as one. Hints belong to a live run and are dropped. */
export function mergeGroups(a: GroupState, b: GroupState): GroupState {
	const cell = a.cell ?? b.cell
	return aloneOrNot({
		readKeys: [...a.readKeys, ...b.readKeys.filter((key) => !a.readKeys.includes(key))],
		anonymousReads: a.anonymousReads + b.anonymousReads,
		searches: a.searches + b.searches,
		lists: a.lists + b.lists,
		mcpCalls: a.mcpCalls + b.mcpCalls,
		mcpLabels: [...a.mcpLabels, ...b.mcpLabels.filter((label) => !a.mcpLabels.includes(label))],
		commands: [...a.commands, ...b.commands],
		...(cell ? { cell } : {}),
	})
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
	run: { live: 'running', done: 'ran', one: 'shell command', many: 'shell commands' },
	mcp: { live: 'calling', done: 'called' },
} as const

/** The words for a version-control clause; `names` sits between the verb and the count. */
const VCS_WORDS: Readonly<
	Record<
		VcsAction,
		{
			live: string
			done: string
			one: string
			many: string
			names?: string
			/** The noun once it is over, when the verb changes it (`ran 1 merge`). */
			doneNouns?: readonly [string, string]
		}
	>
> = {
	commit: { live: 'making', done: 'made', one: 'commit', many: 'commits' },
	amend: { live: 'amending', done: 'amended', one: 'commit', many: 'commits' },
	// The line cannot see a command's result, and a push or a merge that found nothing to do ends well
	// too: once over these say what was run, not what changed.
	push: {
		live: 'pushing',
		done: 'ran',
		one: 'time',
		many: 'times',
		doneNouns: ['push', 'pushes'],
	},
	'create-branch': { live: 'creating', done: 'created', one: 'branch', many: 'branches' },
	'switch-branch': {
		live: 'switching',
		done: 'switched',
		one: 'time',
		many: 'times',
		names: 'branches',
	},
	merge: {
		live: 'merging',
		done: 'ran',
		one: 'branch',
		many: 'branches',
		doneNouns: ['merge', 'merges'],
	},
	rebase: {
		live: 'rebasing',
		done: 'ran',
		one: 'time',
		many: 'times',
		doneNouns: ['rebase', 'rebases'],
	},
	'pr-open': { live: 'opening', done: 'opened', one: 'pull request', many: 'pull requests' },
	'pr-merge': { live: 'merging', done: 'merged', one: 'pull request', many: 'pull requests' },
}

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
	if (state.commands.length > 0) {
		const { counts, absorbed } = vcsTally(state.commands)
		for (const action of VCS_ACTIONS) {
			const n = counts[action]
			if (n === 0) continue
			const w = VCS_WORDS[action]
			parts.push({
				verb: live ? w.live : w.done,
				...(w.names ? { names: w.names } : {}),
				count: n,
				noun:
					live || !w.doneNouns
						? n === 1
							? w.one
							: w.many
						: n === 1
							? w.doneNouns[0]
							: w.doneNouns[1],
			})
		}
		const plain = state.commands.length - absorbed
		if (plain > 0) {
			const w = WORDS.run
			parts.push({
				verb: live ? w.live : w.done,
				count: plain,
				noun: plain === 1 ? w.one : w.many,
			})
		}
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

/** The commands listed under a line, newest last; the ones before are counted, not listed. */
export const COMMAND_ROWS_MAX = 5

/** The columns a listed command hangs in: the gutter and the `$ `. */
export const COMMAND_ROW_INDENT = 5

/** One command as one row of text: its first line, `…` when more follows. */
function commandLine(command: string): string {
	const lines = command
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter((line) => line.length > 0)
	const first = lines[0] ?? ''
	return lines.length > 1 ? `${first} …` : first
}

/** Cut to at most `width` cells, a `…` in the last when something was cut. */
function cutToWidth(text: string, width: number): string {
	const limit = Math.max(1, width)
	if (stringWidth(text) <= limit) return text
	let out = ''
	let used = 0
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
		text,
	)) {
		const cells = stringWidth(segment)
		if (used + cells > limit - 1) break
		out += segment
		used += cells
	}
	return `${out.trimEnd()}…`
}

/**
 * The rows under a group's line that list the commands it ran: a note counting
 * the earlier ones when there are more than are listed, then the last few as
 * `$ command`, each cut to `width` cells so it is one row. None for a group
 * that holds no command or only the one that is drawn as its own row.
 */
export function commandRows(state: GroupState, width: number): readonly string[] {
	if (state.commands.length === 0 || isOneCommand(state)) return []
	const shown = state.commands.slice(-COMMAND_ROWS_MAX)
	const hidden = state.commands.length - shown.length
	return [
		...(hidden > 0
			? [cutToWidth(`${hidden} earlier ${hidden === 1 ? 'command' : 'commands'} not listed`, width)]
			: []),
		...shown.map((command) => cutToWidth(`$ ${commandLine(command)}`, width)),
	]
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
	return splitShell(command)?.segments
}

/** A command line cut at its unquoted operators: the pieces and what joined each to the one before. */
interface ShellSplit {
	readonly segments: readonly string[]
	/** `joins[i]` is how `segments[i]` follows `segments[i - 1]`: `&&` or the first other operator between them. */
	readonly joins: readonly string[]
}

function splitShell(command: string): ShellSplit | undefined {
	const pieces: { text: string; op: string }[] = []
	let current = ''
	let op = ''
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
			let found: string = ch
			if ((ch === '|' || ch === '&') && next === ch) {
				found = ch + ch
				i += 1
			}
			pieces.push({ text: current, op })
			current = ''
			op = found
			continue
		}
		current += ch
	}
	if (quote !== null) return undefined
	pieces.push({ text: current, op })
	const segments: string[] = []
	const joins: string[] = []
	let pending = ''
	for (const piece of pieces) {
		if (piece.op !== '' && piece.op !== '&&' && pending === '') pending = piece.op
		const text = piece.text.trim()
		if (text.length === 0) continue
		segments.push(text)
		joins.push(segments.length === 1 ? '' : pending === '' ? piece.op : pending)
		pending = ''
	}
	return { segments, joins }
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

// ---------------------------------------------------------------------------
// Version-control actions, named in the counted line
// ---------------------------------------------------------------------------

/** What a version-control command did, for the counted line. */
export type VcsAction =
	| 'commit'
	| 'amend'
	| 'push'
	| 'create-branch'
	| 'switch-branch'
	| 'merge'
	| 'rebase'
	| 'pr-open'
	| 'pr-merge'

/** The actions in the order the line prints them. */
export const VCS_ACTIONS: readonly VcsAction[] = [
	'commit',
	'amend',
	'push',
	'create-branch',
	'switch-branch',
	'merge',
	'rebase',
	'pr-open',
	'pr-merge',
]

/** One word of a command segment. `quoted` is true when a quote or backslash took part in it. */
interface Word {
	readonly text: string
	readonly quoted: boolean
	/** Where in `text` the first quoted character starts, or the length when none. */
	readonly plainUntil: number
}

function words(segment: string): readonly Word[] {
	const out: Word[] = []
	let text = ''
	let quoted = false
	let plainUntil = -1
	let open = false
	let quote: '"' | "'" | null = null
	const mark = () => {
		quoted = true
		if (plainUntil < 0) plainUntil = text.length
	}
	for (let i = 0; i < segment.length; i++) {
		const ch = segment.charAt(i)
		if (quote !== null) {
			if (ch === quote) quote = null
			else if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
				text += segment.charAt(i + 1)
				i += 1
			} else text += ch
			continue
		}
		if (ch === '"' || ch === "'") {
			mark()
			open = true
			quote = ch
			continue
		}
		if (ch === '\\' && i + 1 < segment.length) {
			mark()
			open = true
			text += segment.charAt(i + 1)
			i += 1
			continue
		}
		if (/\s/.test(ch)) {
			if (open) out.push({ text, quoted, plainUntil: plainUntil < 0 ? text.length : plainUntil })
			text = ''
			quoted = false
			plainUntil = -1
			open = false
			continue
		}
		open = true
		text += ch
	}
	if (open) out.push({ text, quoted, plainUntil: plainUntil < 0 ? text.length : plainUntil })
	return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A word that is a plain option: `-x`, `--long`, not quoted. */
function isFlag(word: Word): boolean {
	return !word.quoted && word.text.length > 1 && word.text.startsWith('-')
}

/** A long option spelled whole, or as the unique-prefix shorthand git accepts. */
function longMatches(flag: string, full: string, minLength: number): boolean {
	const name = flag.split('=')[0] ?? flag
	return name.startsWith('--') && name.length >= minLength && full.startsWith(name)
}

/** Options (per subcommand) that take the next word as their value, so that word is not read as an option. */
const VALUE_OPTIONS: Readonly<Record<string, { short: string; long: readonly string[] }>> = {
	commit: {
		short: 'mFCct',
		long: [
			'--message',
			'--file',
			'--author',
			'--date',
			'--reuse-message',
			'--reedit-message',
			'--fixup',
			'--squash',
			'--cleanup',
			'--template',
			'--trailer',
		],
	},
	push: {
		short: 'o',
		long: ['--push-option', '--repo', '--receive-pack', '--exec'],
	},
	merge: { short: 'mFsX', long: ['--message', '--file', '--strategy', '--strategy-option'] },
	rebase: {
		short: 'sXxC',
		long: ['--onto', '--strategy', '--strategy-option', '--exec'],
	},
	switch: { short: 'cC', long: ['--conflict', '--create', '--force-create', '--orphan'] },
	checkout: { short: 'bB', long: ['--conflict', '--orphan'] },
	branch: { short: '', long: [] },
	'gh-pr-create': {
		short: 'tbBHlaromTpRF',
		long: [
			'--title',
			'--body',
			'--base',
			'--head',
			'--label',
			'--assignee',
			'--reviewer',
			'--milestone',
			'--project',
			'--template',
			'--repo',
			'--body-file',
			'--recover',
		],
	},
	'gh-pr-merge': {
		short: 'tbFR',
		long: ['--subject', '--body', '--body-file', '--match-head-commit', '--author-email', '--repo'],
	},
}

interface Parsed {
	readonly flags: readonly string[]
	readonly positional: readonly string[]
	/** A word that could hide an option (`$VAR`, a glob) stood where an option could be. */
	readonly unsure: boolean
	/** The word after each flag that takes one, by flag. */
	readonly values: ReadonlyMap<string, string>
}

/** Sort the words after a subcommand into options, plain words and the values options take. */
function parseArgs(rest: readonly Word[], table: string): Parsed {
	const spec = VALUE_OPTIONS[table] ?? { short: '', long: [] }
	const flags: string[] = []
	const positional: string[] = []
	const values = new Map<string, string>()
	let unsure = false
	let onlyPaths = false
	for (let i = 0; i < rest.length; i++) {
		const word = rest[i] as Word
		if (!onlyPaths && !word.quoted && word.text === '--') {
			onlyPaths = true
			continue
		}
		if (!onlyPaths && isFlag(word) && word.text !== '-') {
			flags.push(word.text)
			const long = word.text.startsWith('--')
			const takes = long
				? !word.text.includes('=') &&
					spec.long.some((name) => longMatches(word.text, name, word.text.length))
				: /^-[A-Za-z]*$/.test(word.text) &&
					spec.short.includes(word.text.charAt(word.text.length - 1))
			if (takes && i + 1 < rest.length) {
				values.set(word.text, (rest[i + 1] as Word).text)
				i += 1
			}
			continue
		}
		if (/[$*?[]/.test(word.text) || word.text.startsWith('~')) unsure = true
		positional.push(word.text)
	}
	return { flags, positional, unsure, values }
}

function hasFlag(parsed: Parsed, ...names: string[]): boolean {
	return parsed.flags.some((flag) =>
		names.some((name) =>
			name.startsWith('--')
				? longMatches(flag, name, 3)
				: flag === name || shortCluster(flag, name),
		),
	)
}

/** `-un` holds `-n`: a cluster of one-letter options. */
function shortCluster(flag: string, name: string): boolean {
	return (
		name.length === 2 &&
		/^-[A-Za-z]+$/.test(flag) &&
		!flag.startsWith('--') &&
		flag.slice(1).includes(name.charAt(1))
	)
}

const GIT_FLAGS = new Set([
	'--no-pager',
	'-P',
	'--paginate',
	'-p',
	'--no-optional-locks',
	'--no-replace-objects',
	'--bare',
	'--literal-pathspecs',
	'--no-literal-pathspecs',
	'--glob-pathspecs',
	'--noglob-pathspecs',
	'--icase-pathspecs',
	'--no-advice',
])

type SegmentRead = { readonly action?: VcsAction; readonly explained: boolean }

/** What one segment is: the action it took, and whether it is something this line can account for. */
function readSegment(segment: string): SegmentRead {
	const all = words(segment)
	let i = 0
	while (i < all.length) {
		const word = all[i] as Word
		const eq = word.text.indexOf('=')
		if (ASSIGNMENT.test(word.text) && eq <= word.plainUntil) i += 1
		else break
	}
	const head = all[i]
	if (head === undefined || head.quoted) return { explained: false }
	if (head.text === 'cd' || NEUTRAL_COMMANDS.has(head.text)) return { explained: true }
	if (head.text === 'git') return readGit(all.slice(i + 1))
	if (head.text === 'gh') return readGh(all.slice(i + 1))
	return { explained: false }
}

function readGit(rest: readonly Word[]): SegmentRead {
	let i = 0
	for (; i < rest.length; i++) {
		const word = rest[i] as Word
		if (word.quoted) return { explained: false }
		if (word.text === '-C') {
			i += 1
			continue
		}
		if (word.text === '-c') {
			const value = rest[i + 1]?.text.toLowerCase() ?? ''
			if (value.startsWith('alias.')) return { explained: false }
			i += 1
			continue
		}
		if (word.text === '--git-dir' || word.text === '--work-tree' || word.text === '--namespace') {
			i += 1
			continue
		}
		if (/^--(?:git-dir|work-tree|namespace)=/.test(word.text) || GIT_FLAGS.has(word.text)) continue
		if (word.text.startsWith('-')) return { explained: false }
		break
	}
	const sub = rest[i]
	if (sub === undefined || sub.quoted || /[$*?[~]/.test(sub.text)) return { explained: false }
	const parsed = parseArgs(rest.slice(i + 1), sub.text)
	// What this line cannot account for stays a command of its own: only a step known to change
	// nothing is "explained", and only a dry run or a request for help counts as such inside a
	// subcommand that does change something.
	const unknown: SegmentRead = { explained: false }
	const harmless: SegmentRead = { explained: true }
	if (HARMLESS_GIT.has(sub.text)) return harmless
	if (parsed.unsure) return unknown
	if (hasFlag(parsed, '--help', '-h')) return harmless
	switch (sub.text) {
		case 'commit':
			if (hasFlag(parsed, '--dry-run')) return harmless
			return { action: amendLong(parsed) ? 'amend' : 'commit', explained: true }
		case 'push':
			if (hasFlag(parsed, '--dry-run', '-n')) return harmless
			if (hasFlag(parsed, '--delete', '-d', '--mirror')) return unknown
			return { action: 'push', explained: true }
		case 'merge':
			if (hasFlag(parsed, '--abort', '--quit', '--continue')) return unknown
			return { action: 'merge', explained: true }
		case 'rebase':
			if (
				hasFlag(
					parsed,
					'--abort',
					'--quit',
					'--continue',
					'--skip',
					'--edit-todo',
					'--show-current-patch',
				)
			)
				return unknown
			return { action: 'rebase', explained: true }
		case 'switch': {
			const make = ['-c', '-C', '--create', '--force-create'].find((f) => parsed.values.has(f))
			if (make !== undefined) return { action: 'create-branch', explained: true }
			if (hasFlag(parsed, '--detach', '-d', '--orphan', '--create', '--force-create'))
				return unknown
			return parsed.positional.length === 1 ? { action: 'switch-branch', explained: true } : unknown
		}
		case 'checkout':
			return ['-b', '-B'].some((f) => parsed.values.has(f)) && !hasFlag(parsed, '--orphan')
				? { action: 'create-branch', explained: true }
				: unknown
		case 'branch':
			if (
				parsed.flags.length === 0 &&
				parsed.positional.length >= 1 &&
				parsed.positional.length <= 2
			)
				return { action: 'create-branch', explained: true }
			// Listing branches changes nothing; deleting, renaming and the rest are commands of their own.
			return parsed.positional.length === 0 &&
				parsed.flags.every((flag) => BRANCH_LIST_FLAGS.has(flag))
				? harmless
				: unknown
		default:
			// stash, tag, pull, reset, restore, clean, cherry-pick, revert and every other subcommand.
			return unknown
	}
}

/** Subcommands that only read, or only stage what a commit then takes. */
const HARMLESS_GIT = new Set([
	'add',
	'status',
	'diff',
	'log',
	'show',
	'fetch',
	'rev-parse',
	'rev-list',
	'ls-files',
	'ls-tree',
	'describe',
	'blame',
	'shortlog',
	'grep',
	'cat-file',
	'reflog',
])

/** `git branch` options that only list. */
const BRANCH_LIST_FLAGS = new Set([
	'-a',
	'--all',
	'-r',
	'--remotes',
	'-v',
	'-vv',
	'--verbose',
	'--list',
	'-l',
	'--show-current',
])

/** `--amend`, spelled whole or as a prefix long enough to mean nothing else. */
function amendLong(parsed: Parsed): boolean {
	return parsed.flags.some((flag) => longMatches(flag, '--amend', 4))
}

function readGh(rest: readonly Word[]): SegmentRead {
	const first = rest[0]
	const second = rest[1]
	if (first === undefined || first.quoted || first.text !== 'pr') return { explained: false }
	if (second === undefined || second.quoted) return { explained: false }
	const harmless: SegmentRead = { explained: true }
	const unknown: SegmentRead = { explained: false }
	if (GH_PR_HARMLESS.has(second.text)) return harmless
	if (second.text !== 'create' && second.text !== 'merge') return unknown
	const parsed = parseArgs(rest.slice(2), second.text === 'create' ? 'gh-pr-create' : 'gh-pr-merge')
	if (parsed.unsure) return unknown
	if (parsed.flags.some((flag) => flag === '--help' || flag === '-h')) return harmless
	if (second.text === 'create') {
		if (parsed.flags.includes('--dry-run')) return harmless
		if (parsed.flags.some((flag) => flag === '--web' || flag === '-w')) return unknown
		return { action: 'pr-open', explained: true }
	}
	if (parsed.flags.some((flag) => flag === '--auto' || flag === '--disable-auto')) return unknown
	return { action: 'pr-merge', explained: true }
}

/** `gh pr` subcommands that only read. */
const GH_PR_HARMLESS = new Set(['view', 'list', 'status', 'checks', 'diff'])

/**
 * The version-control actions one successful command line took, and whether
 * the line is nothing but those and harmless pieces around them (so it needs
 * no place of its own in the "ran N commands" count).
 *
 * Only a command word of `git` or `gh` counts, read from the unquoted text
 * after environment assignments and global options; text inside quotes is
 * never a command. Only a chain joined by `&&` is read, because with `;`, `||`
 * or a pipe a successful end does not say every piece succeeded. Anything not
 * known stays a plain command: when in doubt, count less.
 */
export function vcsActions(command: string): {
	readonly actions: readonly VcsAction[]
	readonly absorbed: boolean
} {
	const split = splitShell(command)
	if (!split || split.segments.length === 0) return { actions: [], absorbed: false }
	if (split.joins.some((join, index) => index > 0 && join !== '&&'))
		return { actions: [], absorbed: false }
	const actions: VcsAction[] = []
	let explained = true
	for (const segment of split.segments) {
		const read = readSegment(segment)
		if (read.action !== undefined) actions.push(read.action)
		if (!read.explained) explained = false
	}
	return { actions, absorbed: actions.length > 0 && explained }
}

/** The actions of every command in a group, counted, and how many commands those commands account for. */
export function vcsTally(commands: readonly string[]): {
	readonly counts: Readonly<Record<VcsAction, number>>
	readonly absorbed: number
} {
	const counts: Record<VcsAction, number> = {
		commit: 0,
		amend: 0,
		push: 0,
		'create-branch': 0,
		'switch-branch': 0,
		merge: 0,
		rebase: 0,
		'pr-open': 0,
		'pr-merge': 0,
	}
	let absorbed = 0
	for (const command of commands) {
		const read = vcsActions(command)
		for (const action of read.actions) counts[action] += 1
		if (read.absorbed) absorbed += 1
	}
	return { counts, absorbed }
}
