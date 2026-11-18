/**
 * Where on the screen things that answer the pointer are, and who they are.
 *
 * Each clickable thing (a permission answer, a footer item, a tool row) registers a region: a
 * function that says where it is right now, and what a click and a hover do. A pointer report is
 * handed to the registry first; a report that lands on a region is the region's, and the
 * transcript window never sees it. Positions are read when a report arrives, never kept, so a
 * resize or a scroll cannot leave a region pointing at the wrong cell.
 *
 * Nothing here draws. A region that wants to look hovered holds its own state and sets it from
 * `onHover`, which is called only when the pointer enters or leaves, so a sweep over the screen
 * costs one redraw per target changed and none while it stays on the same one.
 */

import type { DOMElement } from 'ink'

import type { PointerReport } from '../fullscreen/mouse-wheel.js'

/** A rectangle of cells; `x` and `y` count from 1, as pointer reports do. */
export interface Rect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

export interface Region {
	/** Where the region is now; null when it is not on screen. */
	readonly rect: () => Rect | null
	/** A click: the button went down and came up on the region. */
	readonly onClick?: (report: PointerReport) => void
	/** The pointer entered (true) or left (false) the region. */
	readonly onHover?: (hovered: boolean) => void
}

export interface PointerRegions {
	register(region: Region): () => void
	/** Handle one report. True when a region took it, so nothing else should. */
	handle(report: PointerReport): boolean
	/** Regions registered now; for tests. */
	readonly size: number
}

function contains(rect: Rect | null, x: number, y: number): boolean {
	return (
		rect !== null &&
		rect.width > 0 &&
		rect.height > 0 &&
		x >= rect.x &&
		x < rect.x + rect.width &&
		y >= rect.y &&
		y < rect.y + rect.height
	)
}

export function createPointerRegions(): PointerRegions {
	// Registration order is paint order for siblings; the last one registered is on top.
	const regions: Region[] = []
	let pressed: Region | null = null
	let hovered: Region | null = null
	const at = (x: number, y: number, want: 'onClick' | 'onHover'): Region | null => {
		for (let i = regions.length - 1; i >= 0; i--) {
			const region = regions[i] as Region
			if (region[want] !== undefined && contains(region.rect(), x, y)) return region
		}
		return null
	}
	const setHover = (next: Region | null): void => {
		if (next === hovered) return
		const was = hovered
		hovered = next
		was?.onHover?.(false)
		next?.onHover?.(true)
	}
	return {
		register(region) {
			regions.push(region)
			return () => {
				const i = regions.indexOf(region)
				if (i >= 0) regions.splice(i, 1)
				if (pressed === region) pressed = null
				if (hovered === region) hovered = null
			}
		},
		handle(report) {
			if (report.kind === 'move') {
				setHover(at(report.x, report.y, 'onHover'))
				// Motion also tells the transcript window where the pointer is.
				return false
			}
			if (report.kind === 'press') {
				pressed = at(report.x, report.y, 'onClick')
				return pressed !== null
			}
			if (pressed === null) return false
			if (report.kind === 'drag') return true
			const region = pressed
			pressed = null
			// Let go on the same region it went down on: a click. Elsewhere: nothing.
			if (contains(region.rect(), report.x, report.y)) region.onClick?.(report)
			return true
		},
		get size() {
			return regions.length
		},
	}
}

/**
 * Where an element is on the screen, from the layout engine's own numbers: its offset in each
 * ancestor, added up. Null for an element with no layout yet.
 */
export function elementRect(node: DOMElement | null | undefined): Rect | null {
	if (!node?.yogaNode) return null
	let x = 0
	let y = 0
	let at: DOMElement | undefined = node
	while (at?.yogaNode) {
		x += at.yogaNode.getComputedLeft()
		y += at.yogaNode.getComputedTop()
		at = at.parentNode
	}
	return {
		x: x + 1,
		y: y + 1,
		width: node.yogaNode.getComputedWidth(),
		height: node.yogaNode.getComputedHeight(),
	}
}
