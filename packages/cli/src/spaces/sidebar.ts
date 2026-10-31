import stringWidth from 'string-width'
import { ATTR_BOLD, ATTR_DIM } from '../terminal/host/cell.js'
import type { CellStyle, Frame, Rect } from '../terminal/host/frame.js'
import type { GitStatus } from './git.js'
import type { Palette } from './palette.js'
import type { Entry, Roster, Space } from './roster.js'
import { type Dot, limitedNote, spaceNote } from './status.js'
import { leaves } from './tiling.js'

/** How the agents list is ordered: by space, or the ones that want a look first. */
export type AgentOrder = 'grouped' | 'priority'

export interface SidebarScroll {
	/** The first space shown. */
	spaces: number
	/** The first agent shown. */
	agents: number
}

export interface SidebarModel {
	readonly roster: Roster
	readonly mode: 'terminal' | 'navigate'
	/** Lines for the foot of the sidebar: a question, or a name being typed. */
	readonly foot: readonly string[]
	readonly scroll: SidebarScroll
	readonly palette: Palette
	readonly git: (cwd: string) => GitStatus | undefined
	readonly order: AgentOrder
	/** The share of the height the spaces section takes. */
	readonly split: number
	/** Draw the thin rail of dots instead of the lists. */
	readonly rail: boolean
}

export type SidebarTarget =
	| { readonly kind: 'space'; readonly space: Space }
	| { readonly kind: 'agent'; readonly entry: Entry }
	| { readonly kind: 'new' }
	| { readonly kind: 'menu' }
	| { readonly kind: 'order' }
	| { readonly kind: 'collapse' }
	| { readonly kind: 'split' }

const GLYPHS: Record<Dot, string> = {
	blocked: '●',
	done: '●',
	working: '●',
	idle: '○',
	none: '·',
}

function dotColor(dot: Dot, palette: Palette): number {
	switch (dot) {
		case 'blocked':
			return palette.red
		case 'done':
			return palette.teal
		case 'working':
			return palette.yellow
		case 'idle':
			return palette.green
		case 'none':
			return palette.dim
	}
}

/** The glyph and colour of a dot, for the tests that check what a row says. */
export function dotStyle(dot: Dot, palette: Palette): { glyph: string; fg: number } {
	return { glyph: GLYPHS[dot], fg: dotColor(dot, palette) }
}

/** Columns the "new" target covers, counted from the left edge. */
const NEW_WIDTH = 5
/** Columns the "menu" target covers, counted from the right edge. */
const MENU_WIDTH = 6
/** Columns the collapse toggle covers at the foot. */
const TOGGLE_WIDTH = 3
const MIN_SECTION = 3

/** Where each part of the sidebar sits, in rows from its top. */
export interface Geometry {
	readonly rail: boolean
	readonly height: number
	/** The rule between the two sections. */
	readonly ruleY: number
	/** The "spaces" header; none on the rail. */
	readonly headerY: number | undefined
	readonly spaceTop: number
	/** Rows a space takes: 2 in the full sidebar, 1 on the rail. */
	readonly spaceStep: 1 | 2
	/** How many spaces fit. */
	readonly spaceCap: number
	/** The "new" and "menu" row; none on the rail. */
	readonly footerY: number | undefined
	readonly agentHeaderY: number | undefined
	readonly agentTop: number
	readonly agentCap: number
	/** The row with the collapse toggle. */
	readonly toggleY: number
}

/** The rule's row for a split: each section keeps at least three rows where the height allows. */
export function ruleRow(height: number, split: number): number {
	if (height < MIN_SECTION * 2 + 2) return Math.floor(height / 2)
	const wanted = Math.round(height * (Number.isFinite(split) ? split : 0.5))
	return Math.max(MIN_SECTION, Math.min(height - MIN_SECTION - 1, wanted))
}

export function geometry(
	height: number,
	footLines: number,
	split: number,
	rail: boolean,
): Geometry {
	const ruleY = ruleRow(height, split)
	const toggleY = Math.max(0, height - 1)
	if (rail)
		return {
			rail,
			height,
			ruleY,
			headerY: undefined,
			spaceTop: 0,
			spaceStep: 1,
			spaceCap: Math.max(0, ruleY),
			footerY: undefined,
			agentHeaderY: undefined,
			agentTop: ruleY + 1,
			agentCap: Math.max(0, toggleY - (ruleY + 1)),
			toggleY,
		}
	const footerY = ruleY - 1
	const agentTop = ruleY + 3
	const agentBottom = Math.max(agentTop, height - 1 - footLines)
	return {
		rail,
		height,
		ruleY,
		headerY: 0,
		spaceTop: 2,
		spaceStep: 2,
		spaceCap: Math.max(0, Math.floor((footerY - 2) / 2)),
		footerY,
		agentHeaderY: ruleY + 1,
		agentTop,
		agentCap: Math.max(0, Math.floor((agentBottom - agentTop) / 2)),
		toggleY,
	}
}

const RANK: Record<Dot, number> = {
	blocked: 0,
	done: 1,
	working: 2,
	idle: 3,
	none: 4,
}

/** Every session of every space, in the order the agents list shows them. */
export function agentList(roster: Roster, order: AgentOrder): Entry[] {
	const grouped = roster.spaces.flatMap((space) => space.tabs.flatMap((tab) => leaves(tab.root)))
	if (order === 'grouped') return grouped
	return grouped
		.map((entry, index) => ({ entry, index }))
		.sort(
			(a, b) =>
				RANK[a.entry.dot()] - RANK[b.entry.dot()] ||
				b.entry.changedAt - a.entry.changedAt ||
				a.index - b.index,
		)
		.map((item) => item.entry)
}

function within(scroll: number, total: number, cap: number, reveal: number): number {
	const most = Math.max(0, total - cap)
	let next = Math.max(0, Math.min(scroll, most))
	if (reveal >= 0 && cap > 0) {
		if (reveal < next) next = reveal
		else if (reveal >= next + cap) next = reveal - cap + 1
	}
	return Math.max(0, Math.min(next, most))
}

/** Keeps both scrolls in range and, if asked, brings the shown space and session into view. */
export function clampScroll(
	scroll: SidebarScroll,
	model: Pick<SidebarModel, 'roster' | 'order' | 'foot' | 'split' | 'rail'>,
	height: number,
	reveal = false,
): SidebarScroll {
	const geo = geometry(height, model.foot.length, model.split, model.rail)
	const selected = model.roster.selected
	const space = selected ? model.roster.spaceOf(selected) : undefined
	const agents = agentList(model.roster, model.order)
	return {
		spaces: within(
			scroll.spaces,
			model.roster.spaces.length,
			geo.spaceCap,
			reveal && space ? model.roster.spaces.indexOf(space) : -1,
		),
		agents: within(
			scroll.agents,
			agents.length,
			geo.agentCap,
			reveal && selected ? agents.indexOf(selected) : -1,
		),
	}
}

/** Which scrollable list sidebar row `y` is in. */
export function regionAt(
	model: Pick<SidebarModel, 'foot' | 'split' | 'rail'>,
	height: number,
	y: number,
): 'spaces' | 'agents' | undefined {
	const geo = geometry(height, model.foot.length, model.split, model.rail)
	if (y < geo.ruleY) return 'spaces'
	if (y > geo.ruleY) return 'agents'
	return undefined
}

/** The label of the order toggle: the order the list is in now. */
export function orderLabel(order: AgentOrder): string {
	return order
}

/** What a click at a cell of the sidebar lands on. */
export function hitTest(
	model: Pick<SidebarModel, 'roster' | 'scroll' | 'order' | 'foot' | 'split' | 'rail'>,
	width: number,
	height: number,
	x: number,
	y: number,
): SidebarTarget | undefined {
	const geo = geometry(height, model.foot.length, model.split, model.rail)
	if (y === geo.toggleY && x >= width - TOGGLE_WIDTH) return { kind: 'collapse' }
	if (y === geo.ruleY) return { kind: 'split' }
	if (geo.footerY !== undefined && y === geo.footerY) {
		if (x < NEW_WIDTH) return { kind: 'new' }
		if (x >= width - MENU_WIDTH) return { kind: 'menu' }
		return undefined
	}
	if (geo.agentHeaderY !== undefined && y === geo.agentHeaderY) {
		return x >= width - orderLabel(model.order).length - 1 ? { kind: 'order' } : undefined
	}
	const spaceLine = y - geo.spaceTop
	if (spaceLine >= 0 && spaceLine < geo.spaceCap * geo.spaceStep && y < geo.ruleY) {
		const space = model.roster.spaces[model.scroll.spaces + Math.floor(spaceLine / geo.spaceStep)]
		return space ? { kind: 'space', space } : undefined
	}
	const agentLine = y - geo.agentTop
	if (agentLine >= 0 && agentLine < geo.agentCap * geo.spaceStep) {
		const entry = agentList(model.roster, model.order)[
			model.scroll.agents + Math.floor(agentLine / geo.spaceStep)
		]
		return entry ? { kind: 'agent', entry } : undefined
	}
	return undefined
}

function clip(text: string, max: number): string {
	if (max <= 0) return ''
	if (stringWidth(text) <= max) return text
	let out = ''
	let used = 0
	for (const ch of text) {
		const w = stringWidth(ch)
		if (used + w > max - 1) break
		out += ch
		used += w
	}
	return `${out}…`
}

/**
 * The second line of an agent: its tab (when the space has several), its name and
 * its account. When they do not fit, the tab shrinks to its number, then the name
 * gives way; the account is the part worth keeping.
 */
export function agentDetail(
	roster: Roster,
	entry: Entry,
	width = Number.POSITIVE_INFINITY,
): string {
	const space = roster.spaceOf(entry)
	const tab = roster.tabOf(entry)
	const index = tab ? space.tabs.indexOf(tab) + 1 : 0
	const many = space.tabs.length > 1 && tab !== undefined
	const join = (parts: string[]): string => parts.join(' · ')
	const account = entry.account ? [entry.account] : []
	const full = join([...(many ? [tab.name ?? `tab ${index}`] : []), entry.label, ...account])
	if (stringWidth(full) <= width) return full
	const short = join([...(many ? [String(index)] : []), entry.label, ...account])
	if (stringWidth(short) <= width) return short
	const tail = account.length > 0 ? ` · ${entry.account}` : ''
	const head = join([...(many ? [String(index)] : []), entry.label])
	return `${clip(head, Math.max(1, width - stringWidth(tail)))}${tail}`
}

/** What replaces an agent's detail when something about it needs a look. */
function agentWarning(entry: Entry): string | undefined {
	if (entry.folderMissing) return 'folder not found'
	if (entry.openElsewhere) return 'open in another terminal'
	if (entry.limited && entry.activity() !== 'exited')
		return limitedNote(entry.limitedUntil, Date.now())
	return undefined
}

/** Whether any space wants a look: the "menu" target carries a dot then. */
function attention(roster: Roster): Dot | undefined {
	let found: Dot | undefined
	for (const space of roster.spaces) {
		const dot = roster.spaceDot(space)
		if (dot === 'blocked') return dot
		if (dot === 'done') found = dot
	}
	return found
}

export function drawSidebar(frame: Frame, rect: Rect, model: SidebarModel): void {
	const { palette, roster } = model
	const geo = geometry(rect.height, model.foot.length, model.split, model.rail)
	const navigating = model.mode === 'navigate'
	frame.fillRect(rect)
	const at = (x: number, y: number, text: string, style: CellStyle = {}): void => {
		if (x >= rect.width) return
		frame.writeText({ ...rect, x: rect.x + x, width: rect.width - x }, y, text, style)
	}
	const tint = (y: number, height: number, bg: number): void => {
		if (bg >= 0) frame.fillRect({ ...rect, y: rect.y + y, height }, { bg })
	}
	const shown = roster.selected ? roster.spaceOf(roster.selected) : undefined
	const agents = agentList(roster, model.order)

	if (geo.headerY !== undefined) at(1, geo.headerY, 'spaces', { fg: palette.dim, attrs: ATTR_BOLD })
	const spaces = roster.spaces.slice(model.scroll.spaces, model.scroll.spaces + geo.spaceCap)
	spaces.forEach((space, i) => {
		const y = geo.spaceTop + i * geo.spaceStep
		const index = model.scroll.spaces + i
		const focused = space === shown
		const dot = roster.spaceDot(space)
		const bg = focused ? (navigating ? palette.cursorRow : palette.activeRow) : -1
		tint(y, geo.spaceStep, bg)
		if (geo.rail) {
			at(0, y, String(index + 1), { fg: palette.dim, bg })
			at(2, y, GLYPHS[dot], { fg: dotColor(dot, palette), bg })
			return
		}
		at(1, y, GLYPHS[dot], { fg: dotColor(dot, palette), bg })
		at(3, y, clip(space.name, rect.width - 3), {
			fg: focused ? palette.text : palette.subtext,
			bg,
			...(focused ? { attrs: ATTR_BOLD } : {}),
		})
		const note = spaceNote(dot)
		if (note) {
			at(3, y + 1, clip(note, rect.width - 3), {
				fg: dot === 'blocked' ? palette.red : palette.teal,
				bg,
			})
			return
		}
		const git = model.git(space.cwd)
		if (!git) return
		const counts: { text: string; fg: number }[] = []
		if (git.ahead > 0) counts.push({ text: `↑${git.ahead}`, fg: palette.green })
		if (git.behind > 0) counts.push({ text: `↓${git.behind}`, fg: palette.red })
		const tail = counts.reduce((sum, c) => sum + 1 + c.text.length, 0)
		const branch = clip(git.branch, rect.width - 3 - tail)
		at(3, y + 1, branch, { fg: focused ? palette.mauve : palette.dim, bg })
		let x = 3 + stringWidth(branch)
		for (const c of counts) {
			at(x + 1, y + 1, c.text, { fg: c.fg, bg })
			x += 1 + c.text.length
		}
	})

	if (geo.footerY !== undefined) {
		at(1, geo.footerY, 'new', { fg: palette.dim })
		const menuX = rect.width - 4
		at(menuX, geo.footerY, 'menu', { fg: palette.dim })
		const flag = attention(roster)
		if (flag) at(menuX - 2, geo.footerY, GLYPHS[flag], { fg: dotColor(flag, palette) })
	}

	at(0, geo.ruleY, '─'.repeat(rect.width), {
		fg: palette.dim,
		attrs: ATTR_DIM,
	})
	if (geo.agentHeaderY !== undefined) {
		at(1, geo.agentHeaderY, 'agents', { fg: palette.dim, attrs: ATTR_BOLD })
		const label = orderLabel(model.order)
		at(rect.width - label.length, geo.agentHeaderY, label, { fg: palette.dim })
	}
	const visible = agents.slice(model.scroll.agents, model.scroll.agents + geo.agentCap)
	visible.forEach((entry, i) => {
		const y = geo.agentTop + i * geo.spaceStep
		const index = model.scroll.agents + i
		const focused = entry === roster.selected
		const dot = entry.dot()
		const bg = focused ? palette.activeRow : -1
		tint(y, geo.spaceStep, bg)
		if (geo.rail) {
			at(0, y, String(index + 1), { fg: palette.dim, bg })
			at(2, y, GLYPHS[dot], { fg: dotColor(dot, palette), bg })
			return
		}
		at(1, y, GLYPHS[dot], { fg: dotColor(dot, palette), bg })
		const gone = entry.child?.status === 'exited'
		at(3, y, clip(roster.spaceOf(entry).name, rect.width - 3), {
			fg: gone ? palette.dim : focused ? palette.text : palette.subtext,
			bg,
			attrs: ATTR_BOLD,
		})
		const warning = agentWarning(entry)
		at(3, y + 1, clip(warning ?? agentDetail(roster, entry, rect.width - 3), rect.width - 3), {
			fg: warning ? palette.yellow : palette.dim,
			bg,
		})
	})

	const top = rect.height - 1 - model.foot.length
	if (!geo.rail)
		model.foot.forEach((line, i) => at(1, top + i, clip(line, rect.width - 1), { fg: palette.dim }))
	if (geo.rail) at(1, geo.toggleY, '»', { fg: palette.dim })
	else at(rect.width - 1, geo.toggleY, '«', { fg: palette.dim })
}

export function drawRule(frame: Frame, rect: Rect, palette: Palette): void {
	for (let y = 0; y < rect.height; y++)
		frame.writeText({ ...rect, height: rect.height }, y, '│', {
			fg: palette.dim,
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
