import { describe, expect, it } from 'vitest'
import { Entry } from '../roster.js'
import {
	type Node,
	dividerAt,
	leaf,
	leaves,
	neighbour,
	paneAt,
	place,
	placeTab,
	ratioFor,
	removeLeaf,
	resizeAt,
	splitLeaf,
	swapLeaves,
} from '../tiling.js'

const pane = (name: string) => new Entry(name, 'space-1', name)
const AREA = { x: 26, y: 1, width: 134, height: 44 }

/** a | (b over c) */
function threePanes() {
	const [a, b, c] = [pane('a'), pane('b'), pane('c')] as [Entry, Entry, Entry]
	let root: Node = leaf(a)
	root = splitLeaf(root, a, b, 'side')
	root = splitLeaf(root, b, c, 'stack')
	return { a, b, c, root }
}

describe('placing panes', () => {
	it('gives a lone pane the whole area and no border', () => {
		const a = pane('a')
		const placed = place(leaf(a), AREA)
		expect(placed.bordered).toBe(false)
		expect(placed.panes[0]).toMatchObject({ outer: AREA, inner: AREA })
	})

	it('halves a split, the first child taking the odd cell, and gives every pane its own border', () => {
		const { a, b, c, root } = threePanes()
		const { panes, bordered } = place(root, AREA)
		expect(bordered).toBe(true)
		const at = (e: Entry) => panes.find((p) => p.entry === e)
		expect(at(a)?.outer).toEqual({ x: 26, y: 1, width: 67, height: 44 })
		expect(at(b)?.outer).toEqual({ x: 93, y: 1, width: 67, height: 22 })
		expect(at(c)?.outer).toEqual({ x: 93, y: 23, width: 67, height: 22 })
		// Neighbours' borders touch, and the inside is one cell in on each side.
		expect(at(a)?.inner).toEqual({ x: 27, y: 2, width: 65, height: 42 })
		expect(at(b)?.inner).toEqual({ x: 94, y: 2, width: 65, height: 20 })
	})

	it('keeps a ratio inside 10 to 90 percent and every pane above its least size', () => {
		const a = pane('a')
		const b = pane('b')
		const root = splitLeaf(leaf(a), a, b, 'side') as Extract<Node, { kind: 'split' }>
		root.ratio = 0.01
		let first = place(root, AREA).panes[0]?.outer.width as number
		expect(first).toBeGreaterThanOrEqual(12)
		root.ratio = 0.99
		first = place(root, AREA).panes[0]?.outer.width as number
		expect(first).toBe(134 - 12)
		// A room too small for two least-size panes is halved.
		root.ratio = 0.1
		expect(place(root, { ...AREA, width: 20 }).panes[0]?.outer.width).toBe(10)
	})

	it('zooms the focused pane to the whole area, keeping its border', () => {
		const { b, root } = threePanes()
		const zoomed = placeTab({ root, focus: b, zoomed: true }, AREA)
		expect(zoomed.panes).toHaveLength(1)
		expect(zoomed.panes[0]).toMatchObject({ entry: b, outer: AREA })
		expect(zoomed.panes[0]?.inner).toEqual({ x: 27, y: 2, width: 132, height: 42 })
		expect(zoomed.bordered).toBe(true)
		expect(placeTab({ root: leaf(b), focus: b, zoomed: true }, AREA).bordered).toBe(false)
	})
})

describe('moving between panes', () => {
	it('finds the neighbour in each direction, and none past an edge', () => {
		const { a, b, c, root } = threePanes()
		const { panes } = place(root, AREA)
		expect(neighbour(panes, a, 'right')).toBe(c)
		expect(neighbour(panes, b, 'left')).toBe(a)
		expect(neighbour(panes, c, 'left')).toBe(a)
		expect(neighbour(panes, b, 'down')).toBe(c)
		expect(neighbour(panes, c, 'up')).toBe(b)
		expect(neighbour(panes, a, 'left')).toBeUndefined()
		expect(neighbour(panes, a, 'up')).toBeUndefined()
		expect(neighbour(panes, c, 'down')).toBeUndefined()
	})

	it('prefers the pane facing the middle of the edge when several touch it', () => {
		const { a, b, c, root } = threePanes()
		const { panes } = place(root, AREA)
		// a is as tall as b and c together; its middle row is in c, the lower one.
		expect(neighbour(panes, a, 'right')).toBe(c)
		expect(b).toBeDefined()
	})
})

describe('changing the tree', () => {
	it('lists panes left to right and top to bottom', () => {
		const { a, b, c, root } = threePanes()
		expect(leaves(root)).toEqual([a, b, c])
	})

	it('lets the sibling take the room when a pane is removed, and says who lands there', () => {
		const { a, b, c, root } = threePanes()
		const first = removeLeaf(root, b)
		expect(leaves(first.root as Node)).toEqual([a, c])
		expect(first.next).toBe(c)
		const second = removeLeaf(first.root as Node, a)
		expect(second.root).toMatchObject({ kind: 'leaf', entry: c })
		expect(removeLeaf(second.root as Node, c).root).toBeUndefined()
	})

	it('swaps two panes', () => {
		const { a, b, c, root } = threePanes()
		swapLeaves(root, a, c)
		expect(leaves(root)).toEqual([c, b, a])
	})

	it('resizes the nearest split of the right direction, from either side', () => {
		const { a, b, c, root } = threePanes()
		const split = root as Extract<Node, { kind: 'split' }>
		expect(resizeAt(root, a, 'side', true)).toBe(true)
		expect(split.ratio).toBeCloseTo(0.55)
		// b is on the second side, so growing it moves the border the other way.
		expect(resizeAt(root, b, 'side', true)).toBe(true)
		expect(split.ratio).toBeCloseTo(0.5)
		// Height belongs to the inner split, which only b and c are in.
		const inner = split.b as Extract<Node, { kind: 'split' }>
		expect(resizeAt(root, c, 'stack', true)).toBe(true)
		expect(inner.ratio).toBeCloseTo(0.45)
		expect(resizeAt(root, a, 'stack', true)).toBe(false)
		// It stops at the limits.
		for (let i = 0; i < 20; i++) resizeAt(root, a, 'side', true)
		expect(split.ratio).toBe(0.9)
		expect(resizeAt(root, a, 'side', true)).toBe(false)
	})
})

describe('the mouse on borders and panes', () => {
	it('finds the pane under a cell and the border two panes share', () => {
		const { a, b, root } = threePanes()
		const { panes, dividers } = place(root, AREA)
		expect(paneAt(panes, 30, 10)?.entry).toBe(a)
		expect(paneAt(panes, 100, 10)?.entry).toBe(b)
		expect(paneAt(panes, 5, 10)).toBeUndefined()
		// The side border is the two touching columns, 92 and 93, down the whole height.
		expect(dividerAt(dividers, 92, 30)?.split.dir).toBe('side')
		expect(dividerAt(dividers, 93, 30)?.split.dir).toBe('side')
		expect(dividerAt(dividers, 94, 30)).toBeUndefined()
		// The right half's top-over-bottom border is the two touching rows, 22 and 23.
		expect(dividerAt(dividers, 120, 22)?.split.dir).toBe('stack')
		expect(dividerAt(dividers, 60, 22)).toBeUndefined()
	})

	it('turns a pointer position into the ratio that puts the border there', () => {
		const { root } = threePanes()
		const { dividers } = place(root, AREA)
		const side = dividers[0]
		if (!side) throw new Error('no divider')
		expect(ratioFor(side, 26 + 67)).toBeCloseTo(0.5)
		expect(ratioFor(side, 26 + 134 / 4)).toBeCloseTo(0.25)
		expect(ratioFor(side, 0)).toBe(0.1)
		expect(ratioFor(side, 500)).toBe(0.9)
	})
})
