import { foldSearchText } from './text-fold.js'

/**
 * The pure parts of the message box's two typed menus: "/" for commands and "@" for files. They
 * read the box's text and caret and answer in plain values, so nothing here touches the page.
 */

/** One row of the "/" menu. The name is written without its slash. */
export interface SlashEntry {
	readonly name: string
	/** Other names the filter matches; never drawn. */
	readonly aliases?: readonly string[]
	/** Said in the tooltip beside the highlighted row. */
	readonly tooltip: string
	/** Shown in grey after "/name " once the row is picked; present only when the row takes text. */
	readonly argHint?: string
	/** Small muted words at the row's right edge. */
	readonly tag?: string
}

/**
 * What the "/" menu is asked about: the text after the slash, up to the caret. It is null unless
 * the box's first character is "/" and no space lies between it and the caret, so a "/" anywhere
 * else is only text.
 */
export function slashQuery(value: string, caret: number): string | null {
	if (!value.startsWith('/')) return null
	const upToCaret = value.slice(1, Math.max(1, caret))
	if (/\s/.test(upToCaret)) return null
	return upToCaret
}

/** The first word of the box when it starts with "/": its name without the slash, and what follows it. */
export function slashToken(value: string): { name: string; rest: string; spaced: boolean } | null {
	const match = /^\/(\S*)(\s?)([\s\S]*)$/.exec(value)
	if (!match) return null
	return { name: match[1] ?? '', spaced: match[2] !== '', rest: match[3] ?? '' }
}

function tierOf(entry: SlashEntry, query: string): number {
	const name = foldSearchText(entry.name)
	if (name === query) return 0
	if (name.startsWith(query)) return 1
	if (name.includes(query)) return 2
	if (entry.aliases?.some((alias) => foldSearchText(alias).includes(query))) return 3
	if (foldSearchText(entry.tooltip).includes(query)) return 3
	return 4
}

/**
 * The rows that fit the query, best first: an exact name, a name that starts with it, a name that
 * contains it, then an alias or the tooltip that does. Inside one tier the table's own order stays.
 * An empty query lists every row.
 */
export function filterSlash<T extends SlashEntry>(rows: readonly T[], rawQuery: string): T[] {
	const query = foldSearchText(rawQuery.trim())
	if (!query) return [...rows]
	return rows
		.map((entry, order) => ({ entry, order, tier: tierOf(entry, query) }))
		.filter((item) => item.tier < 4)
		.sort((a, b) => a.tier - b.tier || a.order - b.order)
		.map((item) => item.entry)
}

/** The row a typed first word names, by name or alias. */
export function findSlash<T extends SlashEntry>(rows: readonly T[], name: string): T | undefined {
	const word = foldSearchText(name)
	if (!word) return undefined
	return rows.find(
		(entry) =>
			foldSearchText(entry.name) === word ||
			entry.aliases?.some((alias) => foldSearchText(alias) === word),
	)
}

/** What choosing a row does to the box: a row that takes text leaves "/name " and waits, any other runs at once. */
export function pickSlash(entry: SlashEntry): { text: string; run: boolean } {
	return entry.argHint ? { text: `/${entry.name} `, run: false } : { text: '', run: true }
}

/** What Enter does with a box that holds a slash line: a listed command, with the text after its name. */
export function slashLine<T extends SlashEntry>(
	rows: readonly T[],
	value: string,
): { entry: T; argument: string } | null {
	const token = slashToken(value)
	if (!token) return null
	const entry = findSlash(rows, token.name)
	if (!entry) return null
	// A row that takes no text runs only on its own: "/new feature ideas" is a message, not a command.
	if (!entry.argHint && token.rest.trim() !== '') return null
	return { entry, argument: token.rest.trim() }
}

/** The grey hint after "/name " while no argument was typed yet. */
export function argumentGhost<T extends SlashEntry>(
	rows: readonly T[],
	value: string,
): string | undefined {
	const token = slashToken(value)
	if (!token || !token.spaced || token.rest !== '') return undefined
	return findSlash(rows, token.name)?.argHint
}

export interface MirrorParts {
	/** "/word", drawn in the accent colour. */
	command: string
	/** Everything after it, in the text colour. */
	rest: string
	/** Grey words drawn after the text; they are never part of it. */
	ghost?: string
}

/**
 * What the layer behind the box paints, or null when the box is drawn as it is: only a leading
 * "/word" that names a listed command (or the bare "/" of an open menu) is touched, so ordinary
 * typing is never repainted.
 */
export function mirrorParts<T extends SlashEntry>(
	rows: readonly T[],
	value: string,
	menuOpen: boolean,
): MirrorParts | null {
	const token = slashToken(value)
	if (!token) return null
	if (token.name === '') {
		return menuOpen && value === '/' ? { command: '/', rest: '', ghost: 'Type to filter' } : null
	}
	if (!findSlash(rows, token.name)) return null
	const command = `/${token.name}`
	const ghost = argumentGhost(rows, value)
	return { command, rest: value.slice(command.length), ...(ghost ? { ghost } : {}) }
}

/** A key the open menu owns, or null when the box keeps it. PageUp and PageDown move by a page of rows. */
export function menuKeyStep(
	key: string,
	input: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
): 'up' | 'down' | 'page-up' | 'page-down' | 'pick' | 'close' | null {
	if (input.shiftKey || input.altKey || input.ctrlKey || input.metaKey) return null
	switch (key) {
		case 'ArrowUp':
			return 'up'
		case 'ArrowDown':
			return 'down'
		case 'PageUp':
			return 'page-up'
		case 'PageDown':
			return 'page-down'
		case 'Enter':
		case 'Tab':
			return 'pick'
		case 'Escape':
			return 'close'
		default:
			return null
	}
}

const PAGE_ROWS = 7

/** Where the highlight goes after a move. It stops at both ends instead of wrapping. */
export function moveHighlight(
	index: number,
	step: 'up' | 'down' | 'page-up' | 'page-down',
	count: number,
): number {
	if (count <= 0) return 0
	const delta =
		step === 'up' ? -1 : step === 'down' ? 1 : step === 'page-up' ? -PAGE_ROWS : PAGE_ROWS
	return Math.min(count - 1, Math.max(0, index + delta))
}

export interface ActiveMention {
	/** Where the "@" is. */
	start: number
	/** What was typed after it, up to the caret. */
	query: string
	/** Written as @"..." so it may hold spaces. */
	quoted: boolean
}

/**
 * The "@" the caret is in: one at the start of the box or after white space (so an address such as
 * a@b is not one), running to the caret. A quoted name may hold spaces; any other ends at the first.
 */
export function activeMention(value: string, caret: number): ActiveMention | null {
	const before = value.slice(0, caret)
	const quoted = /(^|\s)@"([^"\n]*)$/.exec(before)
	if (quoted) {
		const lead = quoted[1] ?? ''
		return { start: (quoted.index ?? 0) + lead.length, query: quoted[2] ?? '', quoted: true }
	}
	const plain = /(^|\s)@([^\s"]*)$/.exec(before)
	if (plain) {
		const lead = plain[1] ?? ''
		return { start: (plain.index ?? 0) + lead.length, query: plain[2] ?? '', quoted: false }
	}
	return null
}

/** The text a chosen file leaves in the box: @path, or @"a path with spaces", and one space after. */
export function mentionText(path: string): string {
	return /\s/.test(path) ? `@"${path}" ` : `@${path} `
}

/** The box after a file is chosen: the "@query" is replaced by the file's text and the caret sits after it. */
export function applyMention(
	value: string,
	caret: number,
	mention: ActiveMention,
	path: string,
): { value: string; caret: number } {
	const text = mentionText(path)
	// A space already after the caret is not doubled.
	const after = value.slice(caret)
	const rest = after.startsWith(' ') ? after.slice(1) : after
	const next = `${value.slice(0, mention.start)}${text}${rest}`
	return { value: next, caret: mention.start + text.length }
}
