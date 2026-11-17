/**
 * The pane grid: where the panes beside a conversation go, and how wide and tall each one is.
 * Pure arithmetic with no DOM, so every rule here is testable and the component only draws the result.
 *
 * Two things are kept apart. The STORED layout is what the person built: which panes, in which
 * column, with which sizes they dragged. What is DRAWN is `fit(stored, width, height)`, so a window
 * that shrinks folds panes together for a while and a window that grows unfolds them again, and no
 * resize ever rewrites what the person built.
 *
 * Shape: the conversation is always the first column and is never in the layout. At most two more
 * columns, each holding at most two panes. The Session pane is not a column: it is a flag that draws
 * as a docked column or, with no room, as a floating card.
 */

export const PANE_KINDS = ['terminal', 'changes', 'browser', 'files'] as const
/** A pane that lives in a column. */
export type GridKind = (typeof PANE_KINDS)[number]
/** Every pane the bar can toggle: the four above and the Session pane. */
export type PaneKind = GridKind | 'session'

/** The narrowest a column goes. */
export const COL_MIN = 280
/** The conversation never gets less than this beside the panes. */
export const CHAT_MIN = 360
/** Session docks as a column only while the conversation keeps at least this much beside it; otherwise it floats as a card. */
export const CHAT_WITH_SESSION = 560
/** The shortest a pane stacked in a column goes. */
export const ROW_MIN = 160
/** The Session pane docked as a column, and as a floating card. */
export const SESSION_DOCK = 320
export const SESSION_CARD = 280
/** With two columns the conversation keeps half the width; with one column the panes take a third. */
export const CHAT_SHARE_MULTI = 1 / 2
export const SINGLE_SHARE = 1 / 3
/** The most columns, and the most panes in one column. */
export const MAX_COLUMNS = 2
export const MAX_TILES = 2
/** Below this width of the workspace no column fits beside a conversation of CHAT_MIN. */
export const ONE_COLUMN_FROM = CHAT_MIN + COL_MIN
export const TWO_COLUMNS_FROM = CHAT_MIN + 2 * COL_MIN
/** The gap between a floating card and the edge it floats from. */
export const CARD_GAP = 8
export const CARD_TOP = 12

export interface Tile {
	kind: GridKind
	/** A share of the column's height; every tile of a column keeps the same unit. */
	flex: number
}

export interface Column {
	id: string
	tiles: Tile[]
	/** A share of the side area; used only when both columns were sized by a drag. */
	flex: number
	sized: boolean
}

export interface Layout {
	version: 1
	columns: Column[]
	/** The pane that fills the whole workspace, conversation included, until restored. */
	maximised?: GridKind
	/** The person asked for the Session pane; whether it fits decides how it is drawn. */
	sessionWanted: boolean
	/** The width a person dragged a single column to, and the side area of two columns. */
	oneWidth?: number
	twoWidth?: number
}

export const emptyLayout = (sessionWanted = false): Layout => ({
	version: 1,
	columns: [],
	sessionWanted,
})

const COLUMN_IDS = ['c0', 'c1']

export const isGridKind = (value: unknown): value is GridKind =>
	typeof value === 'string' && (PANE_KINDS as readonly string[]).includes(value)

/** Every open pane, left column first, top tile first: the opening order. */
export function openKinds(layout: Layout): GridKind[] {
	return layout.columns.flatMap((column) => column.tiles.map((tile) => tile.kind))
}

export const hasPane = (layout: Layout, kind: GridKind): boolean =>
	layout.columns.some((column) => column.tiles.some((tile) => tile.kind === kind))

/** How many columns fit beside a conversation of at least CHAT_MIN in a workspace this wide. */
export function columnCapacity(width: number): 0 | 1 | 2 {
	if (!Number.isFinite(width)) return 0
	const fits = Math.floor((width - CHAT_MIN) / COL_MIN)
	return fits <= 0 ? 0 : fits === 1 ? 1 : 2
}

const equalise = (tiles: Tile[]): Tile[] => tiles.map((tile) => ({ ...tile, flex: 1 }))

function freeColumnId(layout: Layout): string {
	return COLUMN_IDS.find((id) => !layout.columns.some((column) => column.id === id)) ?? 'c9'
}

/**
 * Opens a pane. The first goes in a column; the second goes below it when the height allows (the
 * opening order reads top to bottom); the third opens the second column; the fourth goes below the
 * third. A pane already open stays where it is. Placement does not look at the width: a narrow
 * window folds the same layout when it draws it, and a wider one unfolds it.
 */
export function placePane(layout: Layout, kind: GridKind, height: number): Layout {
	if (hasPane(layout, kind)) return { ...layout, maximised: undefined }
	const tile: Tile = { kind, flex: 1 }
	const columns = layout.columns.map((column) => ({ ...column, tiles: [...column.tiles] }))
	const last = columns[columns.length - 1]
	const next = (list: Column[]): Layout => ({ ...layout, columns: list, maximised: undefined })
	if (!last) return next([{ id: freeColumnId(layout), tiles: [tile], flex: 1, sized: false }])
	if (last.tiles.length === 1 && height / 2 >= ROW_MIN) {
		last.tiles = equalise([...last.tiles, tile])
		return next(columns)
	}
	if (columns.length < MAX_COLUMNS) {
		return next([
			...columns.map((column) => ({ ...column, sized: false, flex: 1 })),
			{ id: freeColumnId(layout), tiles: [tile], flex: 1, sized: false },
		])
	}
	// No free column: the column with the fewest panes takes it, the right one on a tie.
	let target = columns[0] as Column
	for (const column of columns) if (column.tiles.length <= target.tiles.length) target = column
	target.tiles = equalise([...target.tiles, tile])
	return next(columns)
}

/** Closes a pane; a column with nothing left goes, and the others keep their share equal. */
export function closePane(layout: Layout, kind: GridKind): Layout {
	if (!hasPane(layout, kind)) return layout
	const before = layout.columns.length
	const columns = layout.columns
		.map((column) =>
			column.tiles.some((tile) => tile.kind === kind)
				? { ...column, tiles: equalise(column.tiles.filter((tile) => tile.kind !== kind)) }
				: column,
		)
		.filter((column) => column.tiles.length > 0)
	return {
		...layout,
		columns:
			columns.length === before ? columns : columns.map((c) => ({ ...c, sized: false, flex: 1 })),
		maximised: layout.maximised === kind ? undefined : layout.maximised,
	}
}

export const togglePane = (layout: Layout, kind: GridKind, height: number): Layout =>
	hasPane(layout, kind) ? closePane(layout, kind) : placePane(layout, kind, height)

export const setMaximised = (layout: Layout, kind: GridKind | undefined): Layout =>
	kind === undefined || hasPane(layout, kind) ? { ...layout, maximised: kind } : layout

export const setSessionWanted = (layout: Layout, wanted: boolean): Layout =>
	layout.sessionWanted === wanted ? layout : { ...layout, sessionWanted: wanted }

/** A pane one step to the left, right, up or down, or the same layout when there is nowhere to go. */
export function movePane(
	layout: Layout,
	kind: GridKind,
	direction: 'left' | 'right' | 'up' | 'down',
): Layout {
	const at = layout.columns.findIndex((column) => column.tiles.some((tile) => tile.kind === kind))
	const column = layout.columns[at]
	if (!column) return layout
	const row = column.tiles.findIndex((tile) => tile.kind === kind)
	if (direction === 'up' || direction === 'down') {
		const to = direction === 'up' ? row - 1 : row + 1
		if (to < 0 || to >= column.tiles.length) return layout
		const tiles = [...column.tiles]
		const [moved] = tiles.splice(row, 1)
		tiles.splice(to, 0, moved as Tile)
		return {
			...layout,
			columns: layout.columns.map((c, i) => (i === at ? { ...c, tiles: equalise(tiles) } : c)),
		}
	}
	const other = layout.columns[direction === 'left' ? at - 1 : at + 1]
	if (!other || other.tiles.length >= MAX_TILES) {
		// A swap with the neighbouring column's pane when that one is full.
		if (!other) return layout
		const swapRow = Math.min(row, other.tiles.length - 1)
		const mine = column.tiles[row] as Tile
		const theirs = other.tiles[swapRow] as Tile
		return {
			...layout,
			columns: layout.columns.map((c) =>
				c === column
					? { ...c, tiles: c.tiles.map((t) => (t === mine ? { ...theirs } : t)) }
					: c === other
						? { ...c, tiles: c.tiles.map((t) => (t === theirs ? { ...mine } : t)) }
						: c,
			),
		}
	}
	const moved = column.tiles[row] as Tile
	const columns = layout.columns
		.map((c) => {
			if (c === column) return { ...c, tiles: equalise(c.tiles.filter((t) => t !== moved)) }
			if (c === other)
				return {
					...c,
					tiles: equalise(direction === 'left' ? [...c.tiles, moved] : [moved, ...c.tiles]),
				}
			return c
		})
		.filter((c) => c.tiles.length > 0)
		.map((c) => ({ ...c, sized: false, flex: 1 }))
	return { ...layout, columns }
}

export interface FitTile {
	kind: GridKind
	/** From the top of the grid. */
	top: number
	height: number
}

export interface FitColumn {
	id: string
	/** From the left of the side area. */
	left: number
	width: number
	tiles: FitTile[]
}

export type SessionDraw =
	| { mode: 'off' }
	| { mode: 'dock'; width: number }
	| { mode: 'card'; width: number }

export interface Fit {
	/**
	 * `none`: no pane. `grid`: columns beside the conversation. `overlay`: the workspace is too narrow
	 * for any column, so one pane at a time covers the conversation, which stays mounted.
	 * `maximised`: one pane fills the workspace.
	 */
	mode: 'none' | 'grid' | 'overlay' | 'maximised'
	/** The width the conversation keeps (what a docked Session pane leaves it), 0 when maximised. */
	conversation: number
	/** The width of the columns together. */
	side: number
	columns: FitColumn[]
	/** More panes are stored than columns fit: they are stacked in one column. */
	folded: boolean
	session: SessionDraw
	/** The pane that fills the workspace in `maximised`; the one shown in `overlay`. */
	front?: GridKind
}

/** Splits a height by shares, each tile at least ROW_MIN where the height allows it. */
export function splitHeights(flexes: readonly number[], height: number): number[] {
	const n = flexes.length
	if (n === 0) return []
	if (n === 1) return [Math.max(0, Math.round(height))]
	const total = Math.max(0, Math.round(height))
	if (total < n * ROW_MIN) return spread(total, n)
	const shares = flexes.map((f) => (Number.isFinite(f) && f > 0 ? f : 1))
	const fixed = new Set<number>()
	const out = shares.map(() => 0)
	let free = total
	for (let pass = 0; pass <= n; pass++) {
		const open = shares.map((_, i) => i).filter((i) => !fixed.has(i))
		const sum = open.reduce((acc, i) => acc + (shares[i] as number), 0)
		let clamped = false
		for (const i of open) {
			const h = (free * (shares[i] as number)) / sum
			if (h < ROW_MIN) {
				out[i] = ROW_MIN
				fixed.add(i)
				free -= ROW_MIN
				clamped = true
				break
			}
			out[i] = h
		}
		if (!clamped) break
	}
	// Whole pixels; the last open tile takes the rounding.
	const rounded = out.map((h) => Math.round(h))
	const diff = total - rounded.reduce((a, b) => a + b, 0)
	rounded[n - 1] = (rounded[n - 1] as number) + diff
	return rounded
}

function spread(total: number, n: number): number[] {
	const base = Math.floor(total / n)
	return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base))
}

const clamp = (value: number, low: number, high: number) =>
	Math.min(Math.max(value, low), Math.max(low, high))

/** The side area: what the columns together take at this width. */
function sideWidth(layout: Layout, width: number, drawn: number): number {
	if (drawn === 0) return 0
	if (drawn === 1)
		return Math.round(clamp(layout.oneWidth ?? width * SINGLE_SHARE, COL_MIN, width - CHAT_MIN))
	const natural = Math.max(2 * COL_MIN, Math.min(width * CHAT_SHARE_MULTI, width - CHAT_MIN))
	return Math.round(clamp(layout.twoWidth ?? natural, 2 * COL_MIN, width - CHAT_MIN))
}

function sessionDraw(wanted: boolean, width: number, conversation: number): SessionDraw {
	if (!wanted) return { mode: 'off' }
	if (conversation - SESSION_DOCK >= CHAT_WITH_SESSION) return { mode: 'dock', width: SESSION_DOCK }
	return { mode: 'card', width: Math.min(SESSION_CARD, Math.max(0, width - 2 * CARD_GAP)) }
}

/**
 * What is drawn for a stored layout in a workspace `width` by `height`. `shown` is the pane the
 * overlay brings forward when the workspace is too narrow for columns (the last opened by default).
 */
export function fit(layout: Layout, width: number, height: number, shown?: GridKind): Fit {
	const kinds = openKinds(layout)
	if (kinds.length === 0) {
		return {
			mode: 'none',
			conversation: dockedConversation(width, 0, layout.sessionWanted),
			side: 0,
			columns: [],
			folded: false,
			session: sessionDraw(layout.sessionWanted, width, width),
		}
	}
	if (layout.maximised && kinds.includes(layout.maximised)) {
		return {
			mode: 'maximised',
			conversation: 0,
			side: width,
			columns: [
				{
					id: 'max',
					left: 0,
					width,
					tiles: [{ kind: layout.maximised, top: 0, height }],
				},
			],
			folded: false,
			session: { mode: 'off' },
			front: layout.maximised,
		}
	}
	const capacity = columnCapacity(width)
	if (capacity === 0) {
		const front = shown && kinds.includes(shown) ? shown : (kinds[kinds.length - 1] as GridKind)
		return {
			mode: 'overlay',
			conversation: width,
			side: width,
			columns: [{ id: 'overlay', left: 0, width, tiles: [{ kind: front, top: 0, height }] }],
			folded: kinds.length > 1,
			session: sessionDraw(layout.sessionWanted, width, 0),
			front,
		}
	}
	const folded = layout.columns.length > capacity
	const drawn: Column[] = folded
		? [
				{
					id: layout.columns[0]?.id ?? 'c0',
					flex: 1,
					sized: false,
					tiles: kinds.map((kind) => ({ kind, flex: 1 })),
				},
			]
		: layout.columns
	const side = sideWidth(layout, width, drawn.length)
	let widths: number[]
	if (drawn.length === 1) widths = [side]
	else {
		const [a, b] = drawn as [Column, Column]
		const left =
			a.sized && b.sized
				? clamp(Math.round((side * a.flex) / (a.flex + b.flex)), COL_MIN, side - COL_MIN)
				: Math.round(side / 2)
		widths = [left, side - left]
	}
	let at = 0
	const columns: FitColumn[] = drawn.map((column, i) => {
		const w = widths[i] as number
		const heights = splitHeights(
			column.tiles.map((t) => t.flex),
			height,
		)
		let top = 0
		const tiles = column.tiles.map((tile, row) => {
			const h = heights[row] as number
			const item = { kind: tile.kind, top, height: h }
			top += h
			return item
		})
		const out = { id: column.id, left: at, width: w, tiles }
		at += w
		return out
	})
	const conversation = dockedConversation(width, side, layout.sessionWanted)
	return {
		mode: 'grid',
		conversation,
		side,
		columns,
		folded,
		session: sessionDraw(layout.sessionWanted, width, width - side),
	}
}

/** What the conversation keeps: the workspace less the columns, less the docked Session pane if it docks. */
function dockedConversation(width: number, side: number, sessionWanted: boolean): number {
	const room = width - side
	return sessionWanted && room - SESSION_DOCK >= CHAT_WITH_SESSION ? room - SESSION_DOCK : room
}

/* Dragging. Every function takes the layout, the workspace size and a pixel value, and returns the
   layout with the limits applied. */

/** The seam between the conversation and the first column: how wide the side area is. */
export function dragSide(layout: Layout, width: number, drawnColumns: number, px: number): Layout {
	if (drawnColumns === 1)
		return { ...layout, oneWidth: Math.round(clamp(px, COL_MIN, width - CHAT_MIN)) }
	if (drawnColumns === 2)
		return { ...layout, twoWidth: Math.round(clamp(px, 2 * COL_MIN, width - CHAT_MIN)) }
	return layout
}

export function resetSide(layout: Layout, drawnColumns: number): Layout {
	return drawnColumns === 1
		? { ...layout, oneWidth: undefined }
		: drawnColumns === 2
			? { ...layout, twoWidth: undefined }
			: layout
}

/** The seam between the two columns: the left column's width, the right one taking the rest. */
export function dragColumns(layout: Layout, side: number, leftPx: number): Layout {
	if (layout.columns.length !== 2) return layout
	const left = Math.round(clamp(leftPx, COL_MIN, side - COL_MIN))
	const [a, b] = layout.columns as [Column, Column]
	return {
		...layout,
		columns: [
			{ ...a, flex: left, sized: true },
			{ ...b, flex: side - left, sized: true },
		],
	}
}

export function resetColumns(layout: Layout): Layout {
	return { ...layout, columns: layout.columns.map((c) => ({ ...c, sized: false, flex: 1 })) }
}

/** The seam between two panes of a column: the upper pane's height. */
export function dragRows(layout: Layout, column: string, height: number, topPx: number): Layout {
	const at = layout.columns.findIndex((c) => c.id === column)
	const target = layout.columns[at]
	if (!target || target.tiles.length !== 2) return layout
	const top = Math.round(clamp(topPx, ROW_MIN, height - ROW_MIN))
	const [a, b] = target.tiles as [Tile, Tile]
	return {
		...layout,
		columns: layout.columns.map((c, i) =>
			i === at
				? {
						...c,
						tiles: [
							{ ...a, flex: top },
							{ ...b, flex: height - top },
						],
					}
				: c,
		),
	}
}

export function resetRows(layout: Layout, column: string): Layout {
	return {
		...layout,
		columns: layout.columns.map((c) => (c.id === column ? { ...c, tiles: equalise(c.tiles) } : c)),
	}
}
