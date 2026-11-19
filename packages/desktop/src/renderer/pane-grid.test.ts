import { describe, expect, it } from 'vitest'
import { parseLayout, serializeLayout } from './pane-grid-state.js'
import {
	CHAT_MIN,
	CHAT_WITH_SESSION,
	COL_MIN,
	type GridKind,
	type Layout,
	ROW_MIN,
	SESSION_CARD,
	SESSION_DOCK,
	closePane,
	columnCapacity,
	dragColumns,
	dragRows,
	dragSide,
	emptyLayout,
	fit,
	movePane,
	openKinds,
	placePane,
	resetSide,
	setMaximised,
	setSessionWanted,
	splitHeights,
	togglePane,
} from './pane-grid.js'

const H = 814
const open = (kinds: GridKind[], height = H): Layout =>
	kinds.reduce((layout, kind) => placePane(layout, kind, height), emptyLayout())
const ORDER: GridKind[] = ['terminal', 'changes', 'files', 'browser']

describe('how many columns fit', () => {
	it('keeps the conversation at 360 and each column at 280', () => {
		expect(columnCapacity(639)).toBe(0)
		expect(columnCapacity(640)).toBe(1)
		expect(columnCapacity(919)).toBe(1)
		expect(columnCapacity(920)).toBe(2)
		expect(columnCapacity(3000)).toBe(2)
		expect(columnCapacity(Number.NaN)).toBe(0)
	})
})

describe('placing panes', () => {
	it('puts the second pane under the first, the third in a new column, the fourth under it', () => {
		const shape = (n: number) =>
			open(ORDER.slice(0, n)).columns.map((column) => column.tiles.map((tile) => tile.kind))
		expect(shape(1)).toEqual([['terminal']])
		expect(shape(2)).toEqual([['terminal', 'changes']])
		expect(shape(3)).toEqual([['terminal', 'changes'], ['files']])
		expect(shape(4)).toEqual([
			['terminal', 'changes'],
			['files', 'browser'],
		])
	})

	it('opens the second column when the height is too short to stack', () => {
		const layout = open(['terminal', 'changes'], 2 * ROW_MIN - 1)
		expect(layout.columns.map((column) => column.tiles.length)).toEqual([1, 1])
	})

	it('leaves a pane that is open where it is', () => {
		const layout = open(ORDER)
		expect(openKinds(placePane(layout, 'changes', H))).toEqual(openKinds(layout))
	})

	it('closes a pane, drops an empty column and puts the other columns back to equal', () => {
		let layout = open(ORDER)
		layout = dragColumns(layout, 560, 400)
		layout = closePane(layout, 'browser')
		expect(layout.columns).toHaveLength(2)
		layout = closePane(layout, 'files')
		expect(layout.columns).toHaveLength(1)
		expect(layout.columns[0]?.sized).toBe(false)
		expect(openKinds(layout)).toEqual(['terminal', 'changes'])
	})

	it('toggles', () => {
		const on = togglePane(emptyLayout(), 'files', H)
		expect(openKinds(on)).toEqual(['files'])
		expect(openKinds(togglePane(on, 'files', H))).toEqual([])
	})

	it('moves a pane up, down and across', () => {
		const layout = open(ORDER)
		expect(openKinds(movePane(layout, 'changes', 'up'))).toEqual([
			'changes',
			'terminal',
			'files',
			'browser',
		])
		expect(movePane(layout, 'terminal', 'up')).toBe(layout)
		// The right column is full, so moving across swaps with the pane beside it.
		expect(openKinds(movePane(layout, 'terminal', 'right'))).toEqual([
			'files',
			'changes',
			'terminal',
			'browser',
		])
		const across = movePane(open(['terminal', 'changes', 'files']), 'changes', 'right')
		expect(across.columns.map((c) => c.tiles.map((t) => t.kind))).toEqual([
			['terminal'],
			['changes', 'files'],
		])
	})
})

describe('widths', () => {
	const sizes = (layout: Layout, width: number, height = H) => {
		const out = fit(layout, width, height)
		return {
			conversation: out.conversation,
			columns: out.columns.map((column) => column.width),
		}
	}

	it('gives one column a third and the conversation the rest', () => {
		expect(sizes(open(['terminal']), 1120)).toEqual({ conversation: 747, columns: [373] })
		expect(sizes(open(['terminal', 'changes']), 1136)).toEqual({
			conversation: 757,
			columns: [379],
		})
		expect(sizes(open(['terminal']), 1512)).toEqual({ conversation: 1008, columns: [504] })
	})

	it('gives a single column that opens with a reading pane three fifths, as a terminal keeps a third', () => {
		expect(sizes(open(['changes']), 992)).toEqual({ conversation: 397, columns: [595] })
		expect(sizes(open(['files']), 992)).toEqual({ conversation: 397, columns: [595] })
		expect(sizes(open(['browser']), 992)).toEqual({ conversation: 397, columns: [595] })
		expect(sizes(open(['terminal']), 992)).toEqual({ conversation: 661, columns: [331] })
		// The conversation never drops under its minimum: a narrow workspace caps the reading pane.
		expect(sizes(open(['changes']), 700).conversation).toBe(CHAT_MIN)
	})

	it('gives two columns half and splits it equally', () => {
		expect(sizes(open(ORDER.slice(0, 3)), 1120)).toEqual({ conversation: 560, columns: [280, 280] })
		expect(sizes(open(ORDER), 1136)).toEqual({ conversation: 568, columns: [284, 284] })
		expect(sizes(open(ORDER), 1512)).toEqual({ conversation: 756, columns: [378, 378] })
	})

	it('never leaves the conversation under 360 or a column under 280', () => {
		for (let width = 640; width <= 2400; width += 7) {
			for (let n = 1; n <= 4; n++) {
				const out = fit(open(ORDER.slice(0, n)), width, H)
				expect(out.conversation).toBeGreaterThanOrEqual(CHAT_MIN)
				for (const column of out.columns) expect(column.width).toBeGreaterThanOrEqual(COL_MIN)
				expect(out.conversation + out.side).toBe(width)
			}
		}
	})

	it('keeps a dragged single width and clamps it', () => {
		const layout = dragSide(open(['terminal']), 1120, 1, 500)
		expect(sizes(layout, 1120).columns).toEqual([500])
		expect(sizes(dragSide(layout, 1120, 1, 100), 1120).columns).toEqual([COL_MIN])
		expect(sizes(dragSide(layout, 1120, 1, 5000), 1120).conversation).toBe(CHAT_MIN)
		expect(sizes(resetSide(layout, 1), 1120).columns).toEqual([373])
	})

	it('keeps a dragged width for a narrower window by clamping, and returns to it when the window grows', () => {
		const layout = dragSide(open(['terminal']), 1500, 1, 700)
		expect(sizes(layout, 900).columns).toEqual([540])
		expect(sizes(layout, 1500).columns).toEqual([700])
	})

	it('moves the seam between two columns and keeps both at 280', () => {
		let layout = open(ORDER.slice(0, 3))
		layout = dragColumns(layout, 756, 400)
		expect(sizes(layout, 1512).columns).toEqual([400, 356])
		expect(sizes(dragColumns(layout, 756, 10), 1512).columns).toEqual([COL_MIN, 476])
		expect(sizes(dragColumns(layout, 756, 900), 1512).columns).toEqual([476, COL_MIN])
		// The seam keeps its share when the window changes.
		expect(sizes(layout, 1136).columns.reduce((a, b) => a + b, 0)).toBe(568)
	})
})

describe('heights', () => {
	it('splits a column equally and keeps a dragged share', () => {
		expect(splitHeights([1, 1], 800)).toEqual([400, 400])
		expect(splitHeights([600, 200], 800)).toEqual([600, 200])
	})

	it('keeps each tile at the row minimum', () => {
		expect(splitHeights([1000, 1], 800)).toEqual([640, ROW_MIN])
		expect(splitHeights([1, 1, 1, 1], 400)).toEqual([100, 100, 100, 100])
		const out = splitHeights([1, 1, 1], 700)
		expect(out.reduce((a, b) => a + b, 0)).toBe(700)
		for (const h of out) expect(h).toBeGreaterThanOrEqual(ROW_MIN)
	})

	it('clamps a dragged row to the minimum on both sides', () => {
		const layout = open(['terminal', 'changes'])
		const column = layout.columns[0]?.id ?? ''
		const tall = fit(dragRows(layout, column, H, 5000), 1136, H).columns[0]?.tiles
		expect(tall?.map((t) => t.height)).toEqual([H - ROW_MIN, ROW_MIN])
		const short = fit(dragRows(layout, column, H, 1), 1136, H).columns[0]?.tiles
		expect(short?.map((t) => t.height)).toEqual([ROW_MIN, H - ROW_MIN])
	})

	it('stacks tiles without a gap', () => {
		const [first, second] = fit(open(ORDER), 1136, H).columns[0]?.tiles ?? []
		expect((first?.top ?? 1) + (first?.height ?? 0)).toBe(second?.top)
		expect((second?.top ?? 0) + (second?.height ?? 0)).toBe(H)
	})
})

describe('folding and the overlay', () => {
	it('folds four panes into one stacked column below 920 and unfolds above', () => {
		const layout = open(ORDER)
		const narrow = fit(layout, 800, 900)
		expect(narrow.folded).toBe(true)
		expect(narrow.columns).toHaveLength(1)
		expect(narrow.columns[0]?.tiles.map((t) => t.kind)).toEqual(ORDER)
		expect(narrow.conversation).toBeGreaterThanOrEqual(CHAT_MIN)
		const wide = fit(layout, 1200, 900)
		expect(wide.folded).toBe(false)
		expect(wide.columns).toHaveLength(2)
		// Folding never rewrote what was built.
		expect(layout.columns).toHaveLength(2)
	})

	it('covers the conversation only below 640, and says which pane is in front', () => {
		const layout = open(ORDER.slice(0, 2))
		const out = fit(layout, 600, 700)
		expect(out.mode).toBe('overlay')
		expect(out.front).toBe('changes')
		expect(fit(layout, 600, 700, 'terminal').front).toBe('terminal')
		expect(fit(layout, 640, 700).mode).toBe('grid')
	})

	it('is nothing at all with no pane', () => {
		const out = fit(emptyLayout(), 1000, 700)
		expect(out.mode).toBe('none')
		expect(out.columns).toEqual([])
		expect(out.conversation).toBe(1000)
	})
})

describe('the session pane', () => {
	const wanted = (layout: Layout) => setSessionWanted(layout, true)

	it('docks at 320 when the conversation keeps 560', () => {
		const none = fit(wanted(emptyLayout()), 1120, H)
		expect(none.session).toEqual({ mode: 'dock', width: SESSION_DOCK })
		expect(none.conversation).toBe(800)
		const one = fit(wanted(open(['terminal'])), 1512, H)
		expect(one.session.mode).toBe('dock')
		expect(one.conversation).toBe(1512 - 504 - SESSION_DOCK)
	})

	it('floats as a 280 card when docking would leave the conversation under 560', () => {
		const four = fit(wanted(open(ORDER)), 1120, H)
		expect(four.session).toEqual({ mode: 'card', width: SESSION_CARD })
		expect(four.conversation).toBe(560)
		const wide = fit(wanted(open(ORDER)), 1900, H)
		expect(wide.session.mode).toBe('dock')
		expect(wide.conversation).toBe(950 - SESSION_DOCK)
	})

	it('never squeezes the conversation under 560 beside the docked Session', () => {
		for (const kinds of [['terminal'], ['terminal', 'changes', 'browser'], ORDER] as GridKind[][]) {
			for (let w = 700; w <= 2400; w += 20) {
				const f = fit(wanted(open(kinds)), w, H)
				if (f.session.mode === 'dock')
					expect(f.conversation).toBeGreaterThanOrEqual(CHAT_WITH_SESSION)
				else if (f.mode === 'grid') expect(f.conversation).toBeGreaterThanOrEqual(CHAT_MIN)
			}
		}
		// Three panes at 1392 (a 1680 window less the sidebar): Session is the card.
		expect(fit(wanted(open(['terminal', 'changes', 'browser'])), 1392, H).session.mode).toBe('card')
	})

	it('keeps the flag while it does not fit and docks again when there is room', () => {
		const layout = wanted(open(ORDER))
		expect(fit(layout, 1120, H).session.mode).toBe('card')
		expect(fit(layout, 1900, H).session.mode).toBe('dock')
		expect(layout.sessionWanted).toBe(true)
	})

	it('is a card as wide as the workspace allows when the workspace is tiny', () => {
		expect(fit(wanted(emptyLayout()), 200, H).session).toEqual({ mode: 'card', width: 184 })
	})

	it('is off when not wanted and while a pane is maximised', () => {
		expect(fit(open(['terminal']), 1500, H).session.mode).toBe('off')
		expect(fit(setMaximised(wanted(open(['terminal'])), 'terminal'), 1500, H).session.mode).toBe(
			'off',
		)
	})
})

describe('maximise and restore', () => {
	it('fills the workspace and restores the boxes', () => {
		const layout = open(ORDER)
		const big = fit(setMaximised(layout, 'files'), 1136, H)
		expect(big.mode).toBe('maximised')
		expect(big.conversation).toBe(0)
		expect(big.columns[0]?.tiles[0]).toEqual({ kind: 'files', top: 0, height: H })
		expect(fit(setMaximised(setMaximised(layout, 'files'), undefined), 1136, H)).toEqual(
			fit(layout, 1136, H),
		)
	})

	it('ignores a pane that is not open, and ends when that pane closes or another opens', () => {
		const layout = open(['terminal'])
		expect(setMaximised(layout, 'files')).toBe(layout)
		expect(closePane(setMaximised(layout, 'terminal'), 'terminal').maximised).toBeUndefined()
		expect(placePane(setMaximised(layout, 'terminal'), 'files', H).maximised).toBeUndefined()
	})
})

describe('what is remembered', () => {
	it('round-trips a layout', () => {
		let layout = open(ORDER)
		layout = dragSide(setSessionWanted(layout, true), 1136, 2, 600)
		layout = setMaximised(layout, 'browser')
		expect(parseLayout(serializeLayout(layout))).toEqual({
			...layout,
			oneWidth: undefined,
		})
	})

	it('reads nothing, bad data and strangers as no layout', () => {
		for (const raw of [
			null,
			'',
			'x',
			'[]',
			'{"version":2}',
			`{"version":1,"columns":${'['.repeat(10)}`,
		]) {
			expect(parseLayout(raw).columns).toEqual([])
		}
		expect(parseLayout('x', true).sessionWanted).toBe(true)
		expect(parseLayout('x'.repeat(5000)).columns).toEqual([])
	})

	it('keeps each kind once, at most two columns of two, and only known kinds', () => {
		const raw = JSON.stringify({
			version: 1,
			columns: [
				{
					tiles: [
						{ kind: 'files' },
						{ kind: 'files' },
						{ kind: 'outputs' },
						{ kind: 'terminal' },
						{ kind: 'changes' },
					],
				},
				{ tiles: [{ kind: 'terminal' }] },
				{ tiles: [{ kind: 'browser' }] },
				{ tiles: [{ kind: 'browser' }] },
			],
			maximised: 'activity',
		})
		const layout = parseLayout(raw)
		expect(layout.columns.map((c) => c.tiles.map((t) => t.kind))).toEqual([
			['files', 'terminal'],
			['browser'],
		])
		expect(layout.maximised).toBeUndefined()
	})
})
