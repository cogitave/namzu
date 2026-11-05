import stringWidth from 'string-width'
import { ATTR_BOLD, ATTR_DIM, ATTR_INVERSE } from '../terminal/host/cell.js'
import type { CellStyle, Frame, Rect } from '../terminal/host/frame.js'
import type { GitStatus } from './git.js'
import type { Palette } from './palette.js'
import type { Entry, Roster, Workspace } from './roster.js'
import { type Dot, limitedNote, workspaceNote } from './status.js'
import { leaves } from './tiling.js'

/** How the agents list is ordered: by workspace, or the ones that want a look first. */
export type AgentOrder = 'grouped' | 'priority'

export interface SidebarScroll {
	/** The first workspace shown. */
	workspaces: number
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
	/** The share of the height the workspaces section takes. */
	readonly split: number
	/** Draw the thin rail of dots instead of the lists. */
	readonly rail: boolean
}

export type SidebarTarget =
	| { readonly kind: 'workspace'; readonly workspace: Workspace }
	| { readonly kind: 'agent'; readonly entry: Entry }
	| { readonly kind: 'new' }
	| { readonly kind: 'menu' }
	| { readonly kind: 'order' }
	| { readonly kind: 'collapse' }
	| { readonly kind: 'split' }

/** The shapes differ as well as the colours, so a state reads in 16 colours, with no colour and to a colour-blind eye. */
const GLYPHS: Record<Dot, string> = {
	working: '●',
	idle: '○',
	blocked: '◆',
	done: '✓',
	none: '·',
}

function dotColor(dot: Dot, palette: Palette): number {
	switch (dot) {
		case 'blocked':
			return palette.blocked
		case 'done':
			return palette.done
		case 'working':
			return palette.working
		case 'idle':
			return palette.idle
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
	/** The "workspaces" header; none on the rail. */
	readonly headerY: number | undefined
	readonly workspaceTop: number
	/** Rows the workspaces list has between its top and the "new" row. */
	readonly workspaceRows: number
	/** Rows an agent takes: 2 in the full sidebar, 1 on the rail. */
	readonly agentStep: 1 | 2
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
			workspaceTop: 0,
			workspaceRows: Math.max(0, ruleY),
			agentStep: 1,
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
		workspaceTop: 2,
		workspaceRows: Math.max(0, footerY - 2),
		agentStep: 2,
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

/** Every session of every workspace, in the order the agents list shows them. */
export function agentList(roster: Roster, order: AgentOrder): Entry[] {
	const grouped = roster.workspaces.flatMap((workspace) =>
		workspace.tabs.flatMap((tab) => leaves(tab.root)),
	)
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

/**
 * Rows each workspace takes. The second line holds a note or the branch, and a row
 * with nothing to put there is one line, not a line and a blank one. The rail is
 * always one line.
 */
export function workspaceHeights(
	model: Pick<SidebarModel, 'roster' | 'git' | 'rail'>,
): readonly (1 | 2)[] {
	return model.roster.workspaces.map((workspace) => {
		if (model.rail) return 1
		if (workspaceNote(model.roster.workspaceDot(workspace)) !== undefined) return 2
		return model.git(workspace.cwd) ? 2 : 1
	})
}

/** How many rows, from `start`, fit whole in `rows`. */
function fitting(heights: readonly number[], start: number, rows: number): number {
	let used = 0
	let count = 0
	for (let i = start; i < heights.length; i++) {
		used += heights[i] ?? 1
		if (used > rows) break
		count++
	}
	return count
}

/** The last first-row that still shows everything after it. */
function lastStart(heights: readonly number[], rows: number): number {
	let used = 0
	let start = heights.length
	while (start > 0 && used + (heights[start - 1] ?? 1) <= rows) {
		used += heights[start - 1] ?? 1
		start--
	}
	return start
}

/** `within` for rows of different heights: the first row shown, kept in range and, if asked, with `reveal` in view. */
function withinRows(
	scroll: number,
	heights: readonly number[],
	rows: number,
	reveal: number,
): number {
	const most = lastStart(heights, rows)
	let next = Math.max(0, Math.min(scroll, most))
	if (reveal >= 0 && rows > 0) {
		if (reveal < next) next = reveal
		else while (next < reveal && next + fitting(heights, next, rows) <= reveal) next++
	}
	return Math.max(0, Math.min(next, most))
}

/** Where one workspace sits in the sidebar. */
export interface WorkspaceSlot {
	readonly workspace: Workspace
	readonly index: number
	/** Row from the top of the sidebar. */
	readonly y: number
	readonly height: 1 | 2
}

/** The workspaces on screen, from the first one shown, each with its row and height. */
export function workspaceSlots(
	model: Pick<SidebarModel, 'roster' | 'git' | 'rail' | 'scroll' | 'foot' | 'split'>,
	height: number,
): WorkspaceSlot[] {
	const geo = geometry(height, model.foot.length, model.split, model.rail)
	const heights = workspaceHeights(model)
	const slots: WorkspaceSlot[] = []
	let y = geo.workspaceTop
	for (let index = model.scroll.workspaces; index < heights.length; index++) {
		const rows = heights[index] ?? 1
		if (y + rows > geo.workspaceTop + geo.workspaceRows) break
		const workspace = model.roster.workspaces[index]
		if (workspace) slots.push({ workspace, index, y, height: rows })
		y += rows
	}
	return slots
}

/** Keeps both scrolls in range and, if asked, brings the shown workspace and session into view. */
export function clampScroll(
	scroll: SidebarScroll,
	model: Pick<SidebarModel, 'roster' | 'order' | 'foot' | 'split' | 'rail' | 'git'>,
	height: number,
	reveal = false,
): SidebarScroll {
	const geo = geometry(height, model.foot.length, model.split, model.rail)
	const selected = model.roster.selected
	const workspace = selected ? model.roster.workspaceOf(selected) : undefined
	const agents = agentList(model.roster, model.order)
	return {
		workspaces: withinRows(
			scroll.workspaces,
			workspaceHeights(model),
			geo.workspaceRows,
			reveal && workspace ? model.roster.workspaces.indexOf(workspace) : -1,
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
): 'workspaces' | 'agents' | undefined {
	const geo = geometry(height, model.foot.length, model.split, model.rail)
	if (y < geo.ruleY) return 'workspaces'
	if (y > geo.ruleY) return 'agents'
	return undefined
}

/** The label of the order toggle: the order the list is in now. */
export function orderLabel(order: AgentOrder): string {
	return order
}

/** What a click at a cell of the sidebar lands on. */
export function hitTest(
	model: Pick<SidebarModel, 'roster' | 'scroll' | 'order' | 'foot' | 'split' | 'rail' | 'git'>,
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
	if (y >= geo.workspaceTop && y < geo.ruleY) {
		const slot = workspaceSlots(model, height).find((s) => y >= s.y && y < s.y + s.height)
		return slot ? { kind: 'workspace', workspace: slot.workspace } : undefined
	}
	const agentLine = y - geo.agentTop
	if (agentLine >= 0 && agentLine < geo.agentCap * geo.agentStep) {
		const entry = agentList(model.roster, model.order)[
			model.scroll.agents + Math.floor(agentLine / geo.agentStep)
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
 * The first line of an agent: its workspace and, when the workspace has several tabs,
 * the tab the session is in. When they do not fit the tab shrinks to its number, and then
 * the workspace name gives way.
 */
export function agentHeadline(
	roster: Roster,
	entry: Entry,
	width = Number.POSITIVE_INFINITY,
): string {
	const workspace = roster.workspaceOf(entry)
	const tab = roster.tabOf(entry)
	const index = tab ? workspace.tabs.indexOf(tab) + 1 : 0
	const many = workspace.tabs.length > 1 && tab !== undefined
	if (!many) return clip(workspace.name, width)
	const full = `${workspace.name} · ${tab.name ?? `tab ${index}`}`
	if (stringWidth(full) <= width) return full
	const short = `${workspace.name} · ${index}`
	if (stringWidth(short) <= width) return short
	const tail = ` · ${index}`
	return `${clip(workspace.name, Math.max(1, width - stringWidth(tail)))}${tail}`
}

/**
 * The second line of an agent: its name and its account. The name is what its terminal
 * calls the conversation (the one a person gave it, else the one the small model wrote),
 * and the session's own label until it has one. When they do not fit the name gives way;
 * the account is the part worth keeping.
 */
export function agentDetail(
	_roster: Roster,
	entry: Entry,
	width = Number.POSITIVE_INFINITY,
): string {
	const name = entry.peerName ?? entry.label
	const full = entry.account ? `${name} · ${entry.account}` : name
	if (stringWidth(full) <= width) return full
	const tail = entry.account ? ` · ${entry.account}` : ''
	return `${clip(name, Math.max(1, width - stringWidth(tail)))}${tail}`
}

/** What replaces an agent's detail when something about it needs a look. */
function agentWarning(entry: Entry): string | undefined {
	if (entry.folderMissing) return 'folder not found'
	if (entry.openElsewhere) return 'open in another terminal'
	if (entry.limited && entry.activity() !== 'exited')
		return limitedNote(entry.limitedUntil, Date.now())
	return undefined
}

/** Whether any workspace wants a look: the "menu" target carries a dot then. */
function attention(roster: Roster): Dot | undefined {
	let found: Dot | undefined
	for (const workspace of roster.workspaces) {
		const dot = roster.workspaceDot(workspace)
		if (dot === 'blocked') return dot
		if (dot === 'done') found = dot
	}
	return found
}

/** A foreground that stays readable on a tint: where the two coincide (16 colours), the plain text colour. */
function readable(fg: number, bg: number, palette: Palette): number {
	return bg >= 0 && fg === bg ? palette.text : fg
}

/** The thumb of a list's scrollbar: where it starts and how long it is, in rows; none if the list fits. */
export function scrollThumb(
	total: number,
	cap: number,
	scroll: number,
	rows: number,
): { start: number; length: number } | undefined {
	if (cap <= 0 || total <= cap || rows <= 0) return undefined
	const length = Math.max(1, Math.min(rows, Math.round((rows * cap) / total)))
	const most = total - cap
	const start = Math.round(((rows - length) * Math.max(0, Math.min(scroll, most))) / most)
	return { start, length }
}

/** The row label on the rail: the number, or its last two digits past 99. */
function railIndex(index: number): string {
	return String((index + 1) % 100).padStart(index + 1 > 99 ? 2 : 0, '0')
}

export function drawSidebar(frame: Frame, rect: Rect, model: SidebarModel): void {
	const { palette, roster } = model
	const geo = geometry(rect.height, model.foot.length, model.split, model.rail)
	const navigating = model.mode === 'navigate'
	frame.fillRect(rect)
	const at = (x: number, y: number, text: string, style: CellStyle = {}): void => {
		if (x >= rect.width) return
		const fg =
			style.fg !== undefined && style.bg !== undefined
				? readable(style.fg, style.bg, palette)
				: style.fg
		frame.writeText({ ...rect, x: rect.x + x, width: rect.width - x }, y, text, {
			...style,
			...(fg !== undefined ? { fg } : {}),
		})
	}
	const tint = (y: number, height: number, bg: number): void => {
		if (bg >= 0) frame.fillRect({ ...rect, y: rect.y + y, height }, { bg })
	}
	const bar = (
		x: number,
		top: number,
		rows: number,
		total: number,
		cap: number,
		scroll: number,
	) => {
		const thumb = scrollThumb(total, cap, scroll, rows)
		if (!thumb) return
		for (let i = 0; i < thumb.length; i++) at(x, top + thumb.start + i, '┃', { fg: palette.dim })
	}
	const slots = workspaceSlots(model, rect.height)
	const workspaceRoom = rect.width - 3 - (slots.length < roster.workspaces.length ? 1 : 0)
	const agentRoom = rect.width - 3 - (agentList(roster, model.order).length > geo.agentCap ? 1 : 0)
	const shown = roster.selected ? roster.workspaceOf(roster.selected) : undefined
	const agents = agentList(roster, model.order)

	if (geo.headerY !== undefined)
		at(1, geo.headerY, 'workspaces', { fg: palette.text, attrs: ATTR_BOLD })
	const reversed: [number, number][] = []
	for (const { workspace, index, y, height } of slots) {
		const focused = workspace === shown
		const dot = roster.workspaceDot(workspace)
		const bg = focused ? (navigating ? palette.cursorRow : palette.activeRow) : -1
		tint(y, height, bg)
		// Without colour the cursor row is the one drawn reversed.
		if (palette.mono && focused && navigating) reversed.push([y, height])
		if (geo.rail) {
			at(0, y, railIndex(index), { fg: palette.dim, bg })
			at(2, y, GLYPHS[dot], {
				fg: dotColor(dot, palette),
				bg,
				...(focused ? { attrs: ATTR_BOLD } : {}),
			})
			continue
		}
		at(1, y, GLYPHS[dot], { fg: dotColor(dot, palette), bg })
		at(3, y, clip(workspace.name, workspaceRoom), {
			fg: focused ? palette.text : palette.subtext,
			bg,
			...(focused ? { attrs: ATTR_BOLD } : {}),
		})
		// A row with nothing to say under its name is one line.
		if (height === 1) continue
		const note = workspaceNote(dot)
		if (note) {
			at(3, y + 1, clip(note, workspaceRoom), {
				fg: dot === 'blocked' ? palette.blocked : palette.done,
				bg,
			})
			continue
		}
		const git = model.git(workspace.cwd)
		if (!git) continue
		const counts: { text: string; fg: number }[] = []
		if (git.ahead > 0) counts.push({ text: `↑${git.ahead}`, fg: palette.ahead })
		if (git.behind > 0) counts.push({ text: `↓${git.behind}`, fg: palette.behind })
		const tail = counts.reduce((sum, c) => sum + 1 + c.text.length, 0)
		const branch = clip(git.branch, workspaceRoom - tail)
		at(3, y + 1, branch, { fg: palette.branch, bg })
		let x = 3 + stringWidth(branch)
		for (const c of counts) {
			at(x + 1, y + 1, c.text, { fg: c.fg, bg })
			x += 1 + c.text.length
		}
	}

	for (const [top, rows] of reversed)
		for (let row = 0; row < rows; row++)
			for (let x = 0; x < rect.width; x++) {
				const cell = frame.cellAt(rect.x + x, rect.y + top + row)
				if (cell)
					frame.set(rect.x + x, rect.y + top + row, { ...cell, attrs: cell.attrs | ATTR_INVERSE })
			}
	if (!geo.rail)
		bar(
			rect.width - 1,
			geo.workspaceTop,
			geo.workspaceRows,
			roster.workspaces.length,
			slots.length,
			model.scroll.workspaces,
		)
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
		const y = geo.agentTop + i * geo.agentStep
		const index = model.scroll.agents + i
		const focused = entry === roster.selected
		const dot = entry.dot()
		const bg = focused ? palette.activeRow : -1
		tint(y, geo.agentStep, bg)
		if (geo.rail) {
			at(0, y, railIndex(index), { fg: palette.dim, bg })
			at(2, y, GLYPHS[dot], {
				fg: dotColor(dot, palette),
				bg,
				...(focused ? { attrs: ATTR_BOLD } : {}),
			})
			return
		}
		at(1, y, GLYPHS[dot], { fg: dotColor(dot, palette), bg })
		const gone = entry.child?.status === 'exited'
		at(3, y, agentHeadline(roster, entry, agentRoom), {
			fg: gone ? palette.dim : focused ? palette.text : palette.subtext,
			bg,
			attrs: ATTR_BOLD,
		})
		const warning = agentWarning(entry)
		at(3, y + 1, clip(warning ?? agentDetail(roster, entry, agentRoom), agentRoom), {
			fg: warning ? palette.warn : palette.dim,
			bg,
		})
	})

	if (!geo.rail)
		bar(
			rect.width - 1,
			geo.agentTop,
			geo.agentCap * geo.agentStep,
			agents.length,
			geo.agentCap,
			model.scroll.agents,
		)
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
