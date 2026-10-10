import { describe, expect, it } from 'vitest'
import type { WorkspaceGroup, WorkspaceNode, WorkspaceSplit } from '../shared/workspace-layout.js'
import { workspaceSplitFits } from '../shared/workspace-layout.js'
import { fitWorkspaceDirections, workspaceGeometry } from './workspace-canvas-geometry.js'

const group = (id: string): WorkspaceGroup => ({
	kind: 'group',
	id,
	tabs: [`tab-${id}`],
	activeTabId: `tab-${id}`,
})
const split = (
	id: string,
	first: WorkspaceNode,
	second: WorkspaceNode,
	direction: WorkspaceSplit['direction'] = 'horizontal',
): WorkspaceSplit => ({ kind: 'split', id, direction, ratio: 0.5, first, second })
const directions = (root: WorkspaceNode, width: number) =>
	workspaceGeometry(root, { width, height: 1200 }).dividers.map((entry) => entry.split.direction)

describe('side-by-side panes that no longer fit', () => {
	const pair = () => split('pair', group('a'), group('b'))
	for (const width of [380, 600, 700, 763]) {
		it(`stack at ${width}px and stay inside the width`, () => {
			const geometry = workspaceGeometry(pair(), { width, height: 700 })
			expect(geometry.dividers[0]?.split.direction).toBe('vertical')
			expect(geometry.width).toBe(width)
			for (const { rect } of geometry.groups) {
				expect(rect.x).toBe(0)
				expect(rect.width).toBe(width)
			}
		})
	}
	for (const width of [764, 960, 1600]) {
		it(`stay side by side at ${width}px`, () => {
			const geometry = workspaceGeometry(pair(), { width, height: 700 })
			expect(geometry.dividers[0]?.split.direction).toBe('horizontal')
			for (const { rect } of geometry.groups) {
				expect(rect.width).toBeGreaterThanOrEqual(380)
				expect(rect.x + rect.width).toBeLessThanOrEqual(width)
			}
		})
	}
	it('leaves the saved layout alone and waits for a measured width', () => {
		const tree = pair()
		expect(fitWorkspaceDirections(tree, 600)).not.toBe(tree)
		expect(tree.direction).toBe('horizontal')
		expect(fitWorkspaceDirections(tree, 0)).toBe(tree)
	})
	it('stacks only the split that does not fit', () => {
		const tree = split('outer', group('a'), split('inner', group('b'), group('c')), 'vertical')
		expect(directions(tree, 800)).toEqual(['vertical', 'horizontal'])
		expect(directions(tree, 700)).toEqual(['vertical', 'vertical'])
	})
	it('judges a further split on the stacked panes, as they are drawn', () => {
		// 618 px is too narrow for two side by side, so each pane is 618 wide and half the height.
		expect(workspaceSplitFits(pair(), 'a', 'bottom', { width: 618, height: 1400 })).toBe(true)
		expect(workspaceSplitFits(pair(), 'a', 'bottom', { width: 618, height: 900 })).toBe(false)
		expect(workspaceSplitFits(pair(), 'a', 'right', { width: 618, height: 1400 })).toBe(false)
	})
})
