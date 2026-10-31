import { ATTR_BOLD, ATTR_DIM, ATTR_INVERSE } from '../terminal/host/cell.js'
import type { CellStyle, Frame, Rect } from '../terminal/host/frame.js'
import type { Entry, Roster, Space } from './roster.js'
import { type Dot, activityNote, limitedNote, spaceNote } from './status.js'

const GREY = 8
const GREEN = 2
const CYAN = 6
const RED = 1
const YELLOW = 3
const BLUE = 4

export interface SidebarModel {
	readonly roster: Roster
	readonly mode: 'terminal' | 'navigate'
	/** Lines for the foot of the sidebar: the hints, a question, or a name being typed. */
	readonly foot: readonly string[]
	readonly scroll: SidebarScroll
}

export type SidebarTarget =
	| { readonly kind: 'space'; readonly space: Space }
	| { readonly kind: 'session'; readonly entry: Entry }

interface Row {
	readonly kind: 'space' | 'session' | 'note' | 'heading'
	readonly text: string
	readonly target?: SidebarTarget
	readonly selected?: boolean
	readonly dot?: Dot
	readonly account?: string
	/** A note that asks for a look, drawn in colour. */
	readonly warn?: boolean
}

const DOTS: Record<Dot, { glyph: string; fg: number }> = {
	blocked: { glyph: '●', fg: RED },
	done: { glyph: '●', fg: BLUE },
	working: { glyph: '●', fg: YELLOW },
	idle: { glyph: '○', fg: GREEN },
	none: { glyph: '·', fg: GREY },
}

/** The glyph and colour of a dot, for the tests that check what a row says. */
export function dotStyle(dot: Dot): { glyph: string; fg: number } {
	return DOTS[dot]
}

/** First row of the list: row 0 is the title. */
export const LIST_TOP = 1

/** Rows the list can show above a foot of `footLines`. */
export function listHeight(height: number, footLines: number): number {
	return Math.max(0, height - LIST_TOP - footLines - 1)
}

function noteRow(text: string, target: SidebarTarget, warn = false): Row {
	return { kind: 'note', text, target, ...(warn ? { warn: true } : {}) }
}

function spaceRows(roster: Roster): Row[] {
	const current = roster.selected ? roster.spaceOf(roster.selected) : undefined
	return roster.spaces.flatMap((space, index): Row[] => {
		const dot = roster.spaceDot(space)
		const target: SidebarTarget = { kind: 'space', space }
		const note = spaceNote(dot)
		return [
			{
				kind: 'space',
				text: `${index + 1} ${space.name}`,
				target,
				selected: space === current,
				dot,
			},
			...(note ? [noteRow(note, target)] : []),
		]
	})
}

function sessionRows(roster: Roster): Row[] {
	const selected = roster.selected
	if (!selected) return []
	return roster.entriesOf(roster.spaceOf(selected)).flatMap((entry): Row[] => {
		const target: SidebarTarget = { kind: 'session', entry }
		const base = activityNote(entry.activity(), entry.unseen, entry.child?.ending)
		const note = entry.folderMissing
			? 'folder not found'
			: entry.openElsewhere
				? 'open in another terminal'
				: entry.limited && entry.activity() !== 'exited'
					? limitedNote(entry.limitedUntil, Date.now())
					: base
		return [
			{
				kind: 'session',
				text: entry.label,
				target,
				selected: entry === selected,
				dot: entry.dot(),
				...(entry.account ? { account: entry.account } : {}),
			},
			...(note
				? [noteRow(note, target, entry.folderMissing || (entry.limited && !entry.openElsewhere))]
				: []),
		]
	})
}

/** The sidebar's two lists and how many lines each gets. */
export interface Arrangement {
	readonly spaces: readonly Row[]
	readonly sessions: readonly Row[]
	/** Lines the spaces list shows. */
	readonly spacesHeight: number
	/** Lines the sessions list shows, under its heading. */
	readonly sessionsHeight: number
	readonly heading: string | undefined
}

export interface SidebarScroll {
	spaces: number
	sessions: number
}

/**
 * Spaces on top, the selected space's sessions below. When both do not fit,
 * the sessions get what the spaces do not need, but never less than half.
 */
export function arrange(roster: Roster, height: number, footLines: number): Arrangement {
	const spaces = spaceRows(roster)
	const sessions = sessionRows(roster)
	const selected = roster.selected
	const heading = selected ? `sessions in ${roster.spaceOf(selected).name}` : undefined
	const headingHeight = heading ? 1 : 0
	const room = Math.max(0, listHeight(height, footLines) - headingHeight)
	if (spaces.length + sessions.length <= room)
		return {
			spaces,
			sessions,
			spacesHeight: spaces.length,
			sessionsHeight: sessions.length,
			heading,
		}
	const sessionsHeight = Math.max(
		0,
		Math.min(sessions.length, Math.max(Math.floor(room / 2), room - spaces.length)),
	)
	return {
		spaces,
		sessions,
		spacesHeight: room - sessionsHeight,
		sessionsHeight,
		heading,
	}
}

function within(scroll: number, total: number, height: number, reveal: number): number {
	let next = Math.max(0, Math.min(scroll, Math.max(0, total - height)))
	if (reveal >= 0) {
		if (reveal < next) next = reveal
		else if (reveal >= next + height) next = reveal - height + 1
	}
	return Math.max(0, Math.min(next, Math.max(0, total - height)))
}

/** Keeps both scrolls in range and, if asked, brings the shown space and session into view. */
export function clampScroll(
	scroll: SidebarScroll,
	arrangement: Arrangement,
	reveal = false,
): SidebarScroll {
	const selectedSpace = reveal
		? arrangement.spaces.findIndex((r) => r.kind === 'space' && r.selected)
		: -1
	const selectedSession = reveal
		? arrangement.sessions.findIndex((r) => r.kind === 'session' && r.selected)
		: -1
	return {
		spaces: within(
			scroll.spaces,
			arrangement.spaces.length,
			arrangement.spacesHeight,
			selectedSpace,
		),
		sessions: within(
			scroll.sessions,
			arrangement.sessions.length,
			arrangement.sessionsHeight,
			selectedSession,
		),
	}
}

/** Which list sidebar row `y` is in. */
export function regionAt(arrangement: Arrangement, y: number): 'spaces' | 'sessions' | undefined {
	const line = y - LIST_TOP
	if (line < 0) return undefined
	if (line < arrangement.spacesHeight) return 'spaces'
	if (arrangement.heading === undefined || line === arrangement.spacesHeight) return undefined
	return line - arrangement.spacesHeight - 1 < arrangement.sessionsHeight ? 'sessions' : undefined
}

/** What a click at sidebar row `y` lands on. */
export function hitTest(
	arrangement: Arrangement,
	scroll: SidebarScroll,
	y: number,
): SidebarTarget | undefined {
	const region = regionAt(arrangement, y)
	if (region === 'spaces') return arrangement.spaces[y - LIST_TOP + scroll.spaces]?.target
	if (region === 'sessions')
		return arrangement.sessions[y - LIST_TOP - arrangement.spacesHeight - 1 + scroll.sessions]
			?.target
	return undefined
}

function clip(text: string, max: number): string {
	if (max <= 0) return ''
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function drawRow(frame: Frame, rect: Rect, y: number, row: Row, navigating: boolean): void {
	if (row.kind === 'note') {
		frame.writeText(
			{ ...rect, x: rect.x + 4, width: rect.width - 4 },
			y,
			clip(row.text, rect.width - 5),
			row.warn ? { fg: YELLOW } : { fg: GREY, attrs: ATTR_DIM },
		)
		return
	}
	const entry = row.target?.kind === 'session' ? row.target.entry : undefined
	const gone = entry?.child?.status === 'exited'
	const highlight = navigating && row.selected && row.kind === 'session'
	const style: CellStyle = gone
		? { fg: GREY, attrs: ATTR_DIM }
		: highlight
			? { attrs: ATTR_INVERSE }
			: row.kind === 'space' && row.selected
				? { attrs: ATTR_BOLD }
				: {}
	if (highlight) frame.fillRect({ ...rect, y: rect.y + y, height: 1 }, style)
	frame.writeText(rect, y, row.selected ? '▌' : ' ', {
		fg: CYAN,
		...(style.attrs ? { attrs: style.attrs } : {}),
	})
	const accountWidth = row.account ? row.account.length + 1 : 0
	const room = rect.width - 4 - accountWidth
	frame.writeText(
		{ ...rect, x: rect.x + 1, width: rect.width - 1 },
		y,
		` ${clip(row.text, room)}`,
		style,
	)
	if (row.account)
		frame.writeText(
			{
				...rect,
				x: rect.x + rect.width - 3 - row.account.length,
				width: row.account.length + 1,
			},
			y,
			row.account,
			{ ...style, fg: GREY, attrs: ATTR_DIM },
		)
	const dot = DOTS[row.dot ?? 'none']
	frame.writeText({ ...rect, x: rect.x + rect.width - 2, width: 2 }, y, ` ${dot.glyph}`, {
		...style,
		fg: dot.fg,
	})
}

export function drawSidebar(frame: Frame, rect: Rect, model: SidebarModel): void {
	frame.fillRect(rect)
	frame.writeText(rect, 0, ' spaces', { attrs: ATTR_BOLD })
	const arrangement = arrange(model.roster, rect.height, model.foot.length)
	const navigating = model.mode === 'navigate'
	for (let line = 0; line < arrangement.spacesHeight; line++) {
		const row = arrangement.spaces[line + model.scroll.spaces]
		if (row) drawRow(frame, rect, LIST_TOP + line, row, navigating)
	}
	const headingY = LIST_TOP + arrangement.spacesHeight
	if (arrangement.heading !== undefined) {
		frame.writeText(rect, headingY, ` ${clip(arrangement.heading, rect.width - 2)}`, {
			fg: GREY,
			attrs: ATTR_DIM,
		})
		for (let line = 0; line < arrangement.sessionsHeight; line++) {
			const row = arrangement.sessions[line + model.scroll.sessions]
			if (row) drawRow(frame, rect, headingY + 1 + line, row, navigating)
		}
	}
	const top = rect.height - model.foot.length
	model.foot.forEach((line, i) =>
		frame.writeText(rect, top + i, ` ${clip(line, rect.width - 1)}`, {
			fg: GREY,
			attrs: ATTR_DIM,
		}),
	)
}

export function drawRule(frame: Frame, rect: Rect): void {
	for (let y = 0; y < rect.height; y++)
		frame.writeText({ ...rect, height: rect.height }, y, '│', {
			fg: GREY,
			attrs: ATTR_DIM,
		})
}

/** What the session area says over a session that is gone. */
export function endedMessage(
	ending: 'finished' | 'stopped' | 'could-not-start' | undefined,
	prefixName: string,
): string {
	const leave = `Leave with ${prefixName} q`
	if (ending === 'could-not-start') return `This session could not start. ${leave}.`
	if (ending === 'finished') return `This session has ended. ${leave}.`
	return `This session stopped. Its conversation is saved. ${leave}.`
}
