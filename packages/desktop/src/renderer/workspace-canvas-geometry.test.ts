import { describe, expect, it } from 'vitest'
import type { WorkspaceGroup, WorkspaceNode, WorkspaceSplit } from '../shared/workspace-layout.js'
import {
	createWorkspaceTabDrag,
	parseWorkspaceTabDrag,
	workspaceDragEndsOutsideWindow,
	workspaceDropRect,
	workspaceGeometry,
	workspacePaneSplitFits,
	workspacePointerDrop,
	workspacePointerRatio,
} from './workspace-canvas-geometry.js'

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
	ratio = 0.5,
): WorkspaceSplit => ({ kind: 'split', id, direction, ratio, first, second })

describe('workspace canvas geometry', () => {
	it('keeps groups as stable flat siblings while their recursive positions change', () => {
		const first = group('a')
		const second = group('b')
		const before = workspaceGeometry(split('one', first, second), { width: 1200, height: 700 })
		const after = workspaceGeometry(
			split('two', first, split('three', second, group('c'), 'vertical')),
			{ width: 1200, height: 700 },
		)
		expect(before.groups.map((entry) => entry.group.id)).toEqual(['a', 'b'])
		expect(after.groups.map((entry) => entry.group.id)).toEqual(['a', 'b', 'c'])
		expect(after.groups.find((entry) => entry.group.id === 'a')?.group).toBe(first)
		expect(after.groups.find((entry) => entry.group.id === 'b')?.group).toBe(second)
		expect(after.groups[1]?.rect.y).toBe(0)
		expect(after.groups[2]?.rect.y).toBe(352)
		expect(after.groups[0]?.rect.width).toBe(598)
	})

	it('retains readable eight-pane geometry after the native window becomes smaller', () => {
		const columns = Array.from({ length: 4 }, (_, index) =>
			split(`column-${index}`, group(`${index}-top`), group(`${index}-bottom`), 'vertical'),
		)
		const tree = split(
			'root',
			split('left', columns[0]!, columns[1]!),
			split('right', columns[2]!, columns[3]!),
		)
		const geometry = workspaceGeometry(tree, { width: 560, height: 460 })
		expect(geometry.groups).toHaveLength(8)
		expect(geometry.width).toBe(1532)
		expect(geometry.height).toBe(604)
		for (const { rect } of geometry.groups) {
			expect(rect.width).toBeGreaterThanOrEqual(380)
			expect(rect.height).toBeGreaterThanOrEqual(300)
			expect(rect.x + rect.width).toBeLessThanOrEqual(geometry.width)
			expect(rect.y + rect.height).toBeLessThanOrEqual(geometry.height)
		}
		for (let index = 0; index < geometry.groups.length; index++) {
			for (const other of geometry.groups.slice(index + 1)) {
				const rect = geometry.groups[index]!.rect
				expect(
					rect.x + rect.width <= other.rect.x ||
						other.rect.x + other.rect.width <= rect.x ||
						rect.y + rect.height <= other.rect.y ||
						other.rect.y + other.rect.height <= rect.y,
				).toBe(true)
			}
		}
	})

	it('constrains both restored and live resize ratios by complete branch minimums', () => {
		const tree = split(
			'root',
			split('children', group('a'), group('b')),
			group('c'),
			'horizontal',
			0.01,
		)
		const geometry = workspaceGeometry(tree, { width: 1600, height: 600 })
		const divider = geometry.dividers.find((entry) => entry.split.id === 'root')!
		expect(geometry.groups[0]?.rect.width).toBeGreaterThanOrEqual(380)
		expect(geometry.groups[1]?.rect.width).toBeGreaterThanOrEqual(380)
		expect(geometry.groups[2]?.rect.width).toBeGreaterThanOrEqual(380)
		expect(workspacePointerRatio(divider, -100, 0)).toBe(divider.minimumRatio)
		expect(workspacePointerRatio(divider, 5000, 0)).toBe(divider.maximumRatio)
		expect(workspacePointerRatio(divider, Number.NaN, 0)).toBe(divider.ratio)
		const invalidPreview = workspaceGeometry(
			tree,
			{ width: 1600, height: 600 },
			{ root: Number.NaN },
		)
		expect(invalidPreview.groups.every((entry) => entry.rect.width >= 380)).toBe(true)
	})

	it('uses the correct stacked separator axis including a scroll offset', () => {
		const geometry = workspaceGeometry(split('stacked', group('a'), group('b'), 'vertical'), {
			width: 700,
			height: 1000,
		})
		const divider = geometry.dividers[0]!
		expect(divider.rect).toEqual({ x: 0, y: 498, width: 700, height: 4 })
		expect(workspacePointerRatio(divider, 123, 650)).toBeCloseTo(648 / 996)
		expect(workspacePointerRatio(divider, 123, 500)).toBe(0.5)
	})

	it('handles an empty workspace and pre-observer viewport without invalid coordinates', () => {
		expect(workspaceGeometry(null, { width: 0, height: 0 })).toEqual({
			width: 0,
			height: 0,
			groups: [],
			dividers: [],
		})
		const geometry = workspaceGeometry(group('a'), { width: Number.NaN, height: -100 })
		expect(geometry.width).toBe(380)
		expect(geometry.height).toBe(300)
	})
})

describe('tab drag and drop admission', () => {
	it('detaches only an unaccepted deliberate drop outside the native window', () => {
		const input = {
			x: 1300,
			y: 200,
			dropEffect: 'none',
			cancelled: false,
			window: { x: 100, y: 100, width: 1000, height: 700 },
		}
		expect(workspaceDragEndsOutsideWindow(input)).toBe(true)
		expect(workspaceDragEndsOutsideWindow({ ...input, x: 500 })).toBe(false)
		expect(workspaceDragEndsOutsideWindow({ ...input, x: 1100 })).toBe(true)
		expect(workspaceDragEndsOutsideWindow({ ...input, x: -600 })).toBe(true)
		for (const override of [
			{ cancelled: true },
			{ dropEffect: 'move' },
			{ dropEffect: 'copy' },
			{ x: 0, y: 0 },
			{ x: Number.NaN },
			{ y: Number.POSITIVE_INFINITY },
			{ window: { ...input.window, width: 0 } },
		]) {
			expect(workspaceDragEndsOutsideWindow({ ...input, ...override })).toBe(false)
		}
		expect(
			workspaceDragEndsOutsideWindow({
				...input,
				x: -500,
				window: { x: -1200, y: 100, width: 1000, height: 700 },
			}),
		).toBe(false)
		expect(workspaceDragEndsOutsideWindow({ ...input, x: 0, y: 200 })).toBe(true)
	})

	it('round trips only bounded identity hints for main to authorize', () => {
		const source = { windowId: 'window', groupId: 'group', tabId: 'tab' }
		expect(parseWorkspaceTabDrag(createWorkspaceTabDrag(source))).toEqual(source)
		for (const value of [
			null,
			[],
			{},
			{ ...source, tabId: '' },
			{ ...source, tabId: ' tab' },
			{ ...source, tabId: '\u0000tab' },
			{ ...source, tabId: 'a'.repeat(257) },
			{ ...source, authorized: true },
			{ ...source, windowId: 7 },
		]) {
			expect(parseWorkspaceTabDrag(JSON.stringify(value))).toBeNull()
		}
		expect(parseWorkspaceTabDrag('{')).toBeNull()
		expect(parseWorkspaceTabDrag(' '.repeat(2049))).toBeNull()
		expect(() => createWorkspaceTabDrag({ ...source, groupId: '' })).toThrow(
			'Invalid conversation tab drag.',
		)
	})

	it('previews edges only when both new panes remain readable', () => {
		const rect = { x: 100, y: 200, width: 1000, height: 800 }
		expect(workspacePointerDrop(rect, 101, 500)).toBe('left')
		expect(workspacePointerDrop(rect, 1099, 500)).toBe('right')
		expect(workspacePointerDrop(rect, 500, 201)).toBe('top')
		expect(workspacePointerDrop(rect, 500, 999)).toBe('bottom')
		expect(workspacePointerDrop(rect, 500, 500)).toBe('center')
		expect(workspacePointerDrop(rect, 1, 500)).toBe('center')
		expect(workspacePointerDrop(rect, Number.NaN, 500)).toBe('center')
		const narrow = { ...rect, width: 763, height: 603 }
		expect(workspacePointerDrop(narrow, 101, 500)).toBe('center')
		expect(workspacePointerDrop(narrow, 500, 201)).toBe('center')
		expect(workspacePaneSplitFits({ width: 764, height: 300 }, 'left')).toBe(true)
		expect(workspacePaneSplitFits({ width: 380, height: 604 }, 'top')).toBe(true)
	})

	it('shows the exact new pane rather than covering the divider or retained pane', () => {
		const rect = { x: 100, y: 200, width: 1000, height: 800 }
		expect(workspaceDropRect(rect, 'left')).toEqual({ x: 100, y: 200, width: 498, height: 800 })
		expect(workspaceDropRect(rect, 'right')).toEqual({ x: 602, y: 200, width: 498, height: 800 })
		expect(workspaceDropRect(rect, 'top')).toEqual({ x: 100, y: 200, width: 1000, height: 398 })
		expect(workspaceDropRect(rect, 'bottom')).toEqual({ x: 100, y: 602, width: 1000, height: 398 })
		expect(workspaceDropRect(rect, 'center')).toEqual(rect)
	})
})
