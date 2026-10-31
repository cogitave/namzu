import type { Rect } from '../terminal/host/frame.js'
import type { Entry } from './roster.js'

/** How a split lays its two children out: `side` puts them left and right, `stack` top and bottom. */
export type SplitDir = 'side' | 'stack'

export interface Leaf {
	readonly kind: 'leaf'
	entry: Entry
}

export interface Split {
	readonly kind: 'split'
	dir: SplitDir
	/** The share of the split's room the first child takes. */
	ratio: number
	a: Node
	b: Node
}

/** A tab's panes: a binary tree whose leaves are sessions. */
export type Node = Leaf | Split

export type Direction = 'left' | 'right' | 'up' | 'down'

export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.9
/** The least room a bordered pane gets, border included. */
export const MIN_PANE_WIDTH = 12
export const MIN_PANE_HEIGHT = 5
/** What one resize key moves a border, as a share of its split. */
export const RESIZE_STEP = 0.05

export function leaf(entry: Entry): Leaf {
	return { kind: 'leaf', entry }
}

export function clampRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0.5
	return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio))
}

/** The sessions of a tree, left to right and top to bottom. */
export function leaves(node: Node): Entry[] {
	return node.kind === 'leaf' ? [node.entry] : [...leaves(node.a), ...leaves(node.b)]
}

export function contains(node: Node, entry: Entry): boolean {
	return node.kind === 'leaf'
		? node.entry === entry
		: contains(node.a, entry) || contains(node.b, entry)
}

/** The tree with `created` split off beside `target`; the new pane is the second child. */
export function splitLeaf(node: Node, target: Entry, created: Entry, dir: SplitDir): Node {
	if (node.kind === 'leaf')
		return node.entry === target
			? { kind: 'split', dir, ratio: 0.5, a: node, b: leaf(created) }
			: node
	node.a = splitLeaf(node.a, target, created, dir)
	node.b = splitLeaf(node.b, target, created, dir)
	return node
}

/**
 * The tree without `entry`: its sibling takes the room. `next` is the pane that
 * lands where it was, for focus to move to.
 */
export function removeLeaf(
	node: Node,
	entry: Entry,
): { root: Node | undefined; next: Entry | undefined } {
	if (node.kind === 'leaf')
		return node.entry === entry
			? { root: undefined, next: undefined }
			: { root: node, next: undefined }
	if (node.a.kind === 'leaf' && node.a.entry === entry)
		return { root: node.b, next: leaves(node.b)[0] }
	if (node.b.kind === 'leaf' && node.b.entry === entry)
		return { root: node.a, next: leaves(node.a).at(-1) }
	if (contains(node.a, entry)) {
		const inner = removeLeaf(node.a, entry)
		if (inner.root) node.a = inner.root
		return { root: node, next: inner.next }
	}
	if (contains(node.b, entry)) {
		const inner = removeLeaf(node.b, entry)
		if (inner.root) node.b = inner.root
		return { root: node, next: inner.next }
	}
	return { root: node, next: undefined }
}

/** Swaps the sessions in two leaves. */
export function swapLeaves(node: Node, first: Entry, second: Entry): void {
	if (node.kind === 'leaf') {
		if (node.entry === first) node.entry = second
		else if (node.entry === second) node.entry = first
		return
	}
	swapLeaves(node.a, first, second)
	swapLeaves(node.b, first, second)
}

/**
 * Moves the border that bounds `entry` on the `axis` side (`side` for width,
 * `stack` for height) by one step, growing or shrinking the pane. The nearest
 * enclosing split of that kind is the one that moves.
 */
export function resizeAt(
	node: Node,
	entry: Entry,
	axis: SplitDir,
	grow: boolean,
	step = RESIZE_STEP,
): boolean {
	if (node.kind === 'leaf') return false
	const inA = contains(node.a, entry)
	const child = inA ? node.a : node.b
	if (!inA && !contains(node.b, entry)) return false
	if (resizeAt(child, entry, axis, grow, step)) return true
	if (node.dir !== axis) return false
	const delta = (grow ? step : -step) * (inA ? 1 : -1)
	const next = clampRatio(node.ratio + delta)
	if (next === node.ratio) return false
	node.ratio = next
	return true
}

export interface Placed {
	readonly entry: Entry
	/** The pane with its border. */
	readonly outer: Rect
	/** What the session's terminal gets. */
	readonly inner: Rect
}

/** A border two panes share, which can be dragged. */
export interface Divider {
	readonly split: Split
	/** The room the whole split takes. */
	readonly area: Rect
	/** Where the second child starts: a column for `side`, a row for `stack`. */
	readonly at: number
}

export interface Placement {
	readonly panes: readonly Placed[]
	readonly dividers: readonly Divider[]
	readonly bordered: boolean
}

function shrink(rect: Rect): Rect {
	return {
		x: rect.x + 1,
		y: rect.y + 1,
		width: Math.max(1, rect.width - 2),
		height: Math.max(1, rect.height - 2),
	}
}

function firstShare(total: number, ratio: number, least: number): number {
	const low = Math.min(least, Math.floor(total / 2))
	return Math.max(low, Math.min(total - low, Math.round(total * ratio)))
}

/**
 * Lays the tree out in `area`. With more than one pane every pane has its own
 * border and neighbours' borders touch; a lone pane has none and fills the area.
 */
export function place(root: Node, area: Rect): Placement {
	const count = leaves(root).length
	const bordered = count > 1
	const panes: Placed[] = []
	const dividers: Divider[] = []
	const walk = (node: Node, rect: Rect): void => {
		if (node.kind === 'leaf') {
			panes.push({ entry: node.entry, outer: rect, inner: bordered ? shrink(rect) : rect })
			return
		}
		if (node.dir === 'side') {
			const first = firstShare(rect.width, node.ratio, MIN_PANE_WIDTH)
			dividers.push({ split: node, area: rect, at: rect.x + first })
			walk(node.a, { ...rect, width: first })
			walk(node.b, { ...rect, x: rect.x + first, width: rect.width - first })
		} else {
			const first = firstShare(rect.height, node.ratio, MIN_PANE_HEIGHT)
			dividers.push({ split: node, area: rect, at: rect.y + first })
			walk(node.a, { ...rect, height: first })
			walk(node.b, { ...rect, y: rect.y + first, height: rect.height - first })
		}
	}
	walk(root, area)
	return { panes, dividers, bordered }
}

/** The ratio that puts a split's second child at `at`. */
export function ratioFor(divider: Divider, at: number): number {
	const total = divider.split.dir === 'side' ? divider.area.width : divider.area.height
	const start = divider.split.dir === 'side' ? divider.area.x : divider.area.y
	return clampRatio((at - start) / total)
}

/** The divider whose border covers the cell, if any. */
export function dividerAt(dividers: readonly Divider[], x: number, y: number): Divider | undefined {
	return dividers.find((d) => {
		const { area } = d
		if (d.split.dir === 'side')
			return (x === d.at - 1 || x === d.at) && y >= area.y && y < area.y + area.height
		return (y === d.at - 1 || y === d.at) && x >= area.x && x < area.x + area.width
	})
}

export function paneAt(panes: readonly Placed[], x: number, y: number): Placed | undefined {
	return panes.find(
		({ outer }) =>
			x >= outer.x && x < outer.x + outer.width && y >= outer.y && y < outer.y + outer.height,
	)
}

function overlap(aStart: number, aLen: number, bStart: number, bLen: number): number {
	return Math.max(0, Math.min(aStart + aLen, bStart + bLen) - Math.max(aStart, bStart))
}

/** The pane next to `from` in a direction: the nearest one that shares some of its edge. */
export function neighbour(
	panes: readonly Placed[],
	from: Entry,
	direction: Direction,
): Entry | undefined {
	const origin = panes.find((p) => p.entry === from)?.outer
	if (!origin) return undefined
	const horizontal = direction === 'left' || direction === 'right'
	const middle = horizontal ? origin.y + origin.height / 2 : origin.x + origin.width / 2
	let best: { entry: Entry; gap: number; across: number; covers: boolean } | undefined
	for (const { entry, outer } of panes) {
		if (entry === from) continue
		let gap: number
		if (direction === 'left') gap = origin.x - (outer.x + outer.width)
		else if (direction === 'right') gap = outer.x - (origin.x + origin.width)
		else if (direction === 'up') gap = origin.y - (outer.y + outer.height)
		else gap = outer.y - (origin.y + origin.height)
		if (gap < 0) continue
		const across = horizontal
			? overlap(origin.y, origin.height, outer.y, outer.height)
			: overlap(origin.x, origin.width, outer.x, outer.width)
		if (across === 0) continue
		const start = horizontal ? outer.y : outer.x
		const length = horizontal ? outer.height : outer.width
		const covers = middle >= start && middle < start + length
		if (
			!best ||
			gap < best.gap ||
			(gap === best.gap &&
				(Number(covers) > Number(best.covers) || (covers === best.covers && across > best.across)))
		)
			best = { entry, gap, across, covers }
	}
	return best?.entry
}

/** Lays a tab out: zoomed, its focused pane alone takes the whole area and keeps its border. */
export function placeTab(
	tab: { root: Node; focus: Entry; zoomed: boolean },
	area: Rect,
): Placement {
	if (tab.zoomed && leaves(tab.root).length > 1)
		return {
			panes: [{ entry: tab.focus, outer: area, inner: shrink(area) }],
			dividers: [],
			bordered: true,
		}
	return place(tab.root, area)
}
