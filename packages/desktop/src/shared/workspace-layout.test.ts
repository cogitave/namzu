import { describe, expect, it } from 'vitest'
import {
	type WorkspaceGroup,
	type WorkspaceLayoutSnapshot,
	type WorkspaceMoveTab,
	type WorkspaceNode,
	type WorkspaceSplit,
	activateWorkspaceTab,
	addWorkspaceWindow,
	closeWorkspaceTab,
	constrainWorkspaceSplitRatio,
	createWorkspaceLayout,
	locateWorkspaceTab,
	moveWorkspaceTab,
	openWorkspaceTab,
	parseWorkspaceLayout,
	removeWorkspaceWindow,
	resizeWorkspaceSplit,
	workspaceGroupSize,
	workspaceGroups,
	workspaceMinimumSize,
	workspaceSplitFits,
} from './workspace-layout.js'

const group = (id: string, tabs: string[], activeTabId = tabs[0] as string): WorkspaceGroup => ({
	kind: 'group',
	id,
	tabs,
	activeTabId,
})

const split = (
	id: string,
	first: WorkspaceNode,
	second: WorkspaceNode,
	direction: 'horizontal' | 'vertical' = 'horizontal',
	ratio = 0.5,
): WorkspaceSplit => ({ kind: 'split', id, direction, ratio, first, second })

const layout = (root: WorkspaceNode = group('g1', ['a', 'b', 'c'])): WorkspaceLayoutSnapshot => ({
	version: 1,
	revision: 7,
	windows: [{ id: 'w1', root, focusedGroupId: workspaceGroups(root)[0]?.id ?? null }],
})

const move = (overrides: Partial<WorkspaceMoveTab> = {}): WorkspaceMoveTab => ({
	tabId: 'a',
	sourceWindowId: 'w1',
	sourceGroupId: 'g1',
	targetWindowId: 'w1',
	targetGroupId: 'g1',
	position: 'right',
	newGroupId: 'g2',
	newSplitId: 's1',
	...overrides,
})

describe('workspace persistence validation', () => {
	it('round trips a multi-window tree and copies untrusted arrays and bounds', () => {
		const input = layout(split('s1', group('g1', ['a']), group('g2', ['b', 'c'], 'c')))
		input.windows[0]!.bounds = { x: -1300, y: 20, width: 1200, height: 800 }
		input.windows.push({ id: 'w2', root: group('g3', ['d']), focusedGroupId: 'g3' })
		const parsed = parseWorkspaceLayout(JSON.parse(JSON.stringify(input)))
		expect(parsed).toEqual(input)
		expect(parsed).not.toBe(input)
		expect(parsed?.windows[0]?.root).not.toBe(input.windows[0]?.root)
		expect(parsed?.windows[0]?.bounds).not.toBe(input.windows[0]?.bounds)
	})

	it.each([
		{ version: 2 },
		{ revision: -1 },
		{ revision: Number.MAX_SAFE_INTEGER + 1 },
		{ revision: Number.NaN },
		{ windows: [] },
	])('rejects malformed snapshot metadata %j', (changes) => {
		expect(parseWorkspaceLayout({ ...layout(), ...changes })).toBeNull()
	})

	it('refuses duplicated tab writers and duplicated tree or window identities', () => {
		const duplicateTab = layout(split('s1', group('g1', ['a']), group('g2', ['a'])))
		expect(parseWorkspaceLayout(duplicateTab)).toBeNull()
		const duplicateGroup = layout(split('s1', group('g1', ['a']), group('g1', ['b'])))
		expect(parseWorkspaceLayout(duplicateGroup)).toBeNull()
		const duplicateSplit = layout(
			split('s1', split('s1', group('g1', ['a']), group('g2', ['b'])), group('g3', ['c'])),
		)
		expect(parseWorkspaceLayout(duplicateSplit)).toBeNull()
		const duplicateWindow = layout()
		duplicateWindow.windows.push({ id: 'w1', root: null, focusedGroupId: null })
		expect(parseWorkspaceLayout(duplicateWindow)).toBeNull()
		const acrossWindows = layout(group('g1', ['a']))
		acrossWindows.windows.push({ id: 'w2', root: group('g2', ['a']), focusedGroupId: 'g2' })
		expect(parseWorkspaceLayout(acrossWindows)).toBeNull()
	})

	it('rejects empty groups, absent active tabs, split focus and control characters in identities', () => {
		expect(parseWorkspaceLayout(layout(group('g1', [], 'a')))).toBeNull()
		expect(parseWorkspaceLayout(layout(group('g1', ['a'], 'b')))).toBeNull()
		const splitFocus = layout(split('s1', group('g1', ['a']), group('g2', ['b'])))
		splitFocus.windows[0]!.focusedGroupId = 's1'
		expect(parseWorkspaceLayout(splitFocus)).toBeNull()
		expect(parseWorkspaceLayout(layout(group('g1', ['a\n'])))).toBeNull()
		expect(parseWorkspaceLayout(layout(group(' g1', ['a'])))).toBeNull()
	})

	it.each([0, 1, Number.NaN, Number.POSITIVE_INFINITY, '0.5'])(
		'rejects split ratio %j',
		(ratio) => {
			const root = { ...split('s1', group('g1', ['a']), group('g2', ['b'])), ratio }
			expect(
				parseWorkspaceLayout({ ...layout(), windows: [{ id: 'w1', root, focusedGroupId: 'g1' }] }),
			).toBeNull()
		},
	)

	it('bounds recursive, cyclic, oversized input and rejects invalid native bounds', () => {
		let root: WorkspaceNode = group('g0', ['a0'])
		for (let i = 1; i <= 66; i++) root = split(`s${i}`, root, group(`g${i}`, [`a${i}`]))
		expect(parseWorkspaceLayout(layout(root))).toBeNull()
		const cyclic = split('cycle', group('g1', ['a']), group('g2', ['b']))
		cyclic.second = cyclic
		expect(
			parseWorkspaceLayout({
				...layout(),
				windows: [{ id: 'w1', root: cyclic, focusedGroupId: 'g1' }],
			}),
		).toBeNull()
		const manyWindows = createWorkspaceLayout('w0')
		for (let i = 1; i <= 64; i++)
			manyWindows.windows.push({ id: `w${i}`, root: null, focusedGroupId: null })
		expect(parseWorkspaceLayout(manyWindows)).toBeNull()
		for (const bounds of [
			{ x: 0, y: 0, width: 0, height: 800 },
			{ x: Number.NaN, y: 0, width: 1200, height: 800 },
			{ x: 0.2, y: 0, width: 1200, height: 800 },
		]) {
			const input = layout()
			input.windows[0]!.bounds = bounds
			expect(parseWorkspaceLayout(input)).toBeNull()
		}
	})

	it('requires empty native windows to have no focused group', () => {
		expect(parseWorkspaceLayout(createWorkspaceLayout('w1'))).toEqual(createWorkspaceLayout('w1'))
		expect(
			parseWorkspaceLayout({
				...createWorkspaceLayout('w1'),
				windows: [{ id: 'w1', root: null, focusedGroupId: 'missing' }],
			}),
		).toBeNull()
	})
})

describe('workspace tab ownership and tree edits', () => {
	it.each([
		['left', 'horizontal', true],
		['right', 'horizontal', false],
		['top', 'vertical', true],
		['bottom', 'vertical', false],
	] as const)(
		'splits a tab onto %s atomically without changing the original tree',
		(position, direction, first) => {
			const original = layout()
			const before = JSON.stringify(original)
			const next = moveWorkspaceTab(original, move({ position }))
			expect(next?.revision).toBe(original.revision + 1)
			expect(JSON.stringify(original)).toBe(before)
			expect(next?.windows[0]?.root).toEqual(
				split(
					's1',
					first ? group('g2', ['a']) : group('g1', ['b', 'c'], 'b'),
					first ? group('g1', ['b', 'c'], 'b') : group('g2', ['a']),
					direction,
				),
			)
			expect(next?.windows[0]?.focusedGroupId).toBe('g2')
			expect(parseWorkspaceLayout(next)).toEqual(next)
		},
	)

	it('merges another group and collapses its empty ancestor with surviving identity and focus', () => {
		const original = layout(
			split(
				'outer',
				group('left', ['a']),
				split('inner', group('middle', ['b']), group('right', ['c'])),
			),
		)
		const next = moveWorkspaceTab(
			original,
			move({ sourceGroupId: 'left', targetGroupId: 'middle', position: 'center' }),
		)
		expect(next?.windows[0]?.root).toEqual(
			split('inner', group('middle', ['b', 'a'], 'a'), group('right', ['c'])),
		)
		expect(next?.windows[0]?.focusedGroupId).toBe('middle')
		expect(locateWorkspaceTab(next as WorkspaceLayoutSnapshot, 'a')).toEqual({
			windowId: 'w1',
			groupId: 'middle',
			index: 1,
		})
	})

	it('moves between native windows once, preserving the source active fallback', () => {
		const original = layout(group('g1', ['a', 'b', 'c'], 'b'))
		original.windows.push({ id: 'w2', root: group('g2', ['d']), focusedGroupId: 'g2' })
		const next = moveWorkspaceTab(
			original,
			move({ tabId: 'b', targetWindowId: 'w2', targetGroupId: 'g2', position: 'center', index: 0 }),
		)
		expect(next?.windows[0]?.root).toEqual(group('g1', ['a', 'c'], 'c'))
		expect(next?.windows[1]?.root).toEqual(group('g2', ['b', 'd'], 'b'))
		expect(next?.revision).toBe(8)
		expect(parseWorkspaceLayout(next)).toEqual(next)
	})

	it('commits a prepared detach into an empty native window in one model revision', () => {
		const original = addWorkspaceWindow(layout(group('g1', ['a'])), { id: 'w2' })!
		const next = moveWorkspaceTab(
			original,
			move({ targetWindowId: 'w2', targetGroupId: 'detached-group', position: 'center' }),
		)
		expect(next?.revision).toBe(original.revision + 1)
		expect(next?.windows[0]).toMatchObject({ root: null, focusedGroupId: null })
		expect(next?.windows[1]).toMatchObject({
			root: group('detached-group', ['a']),
			focusedGroupId: 'detached-group',
		})
		expect(parseWorkspaceLayout(next)).toEqual(next)
		const removed = removeWorkspaceWindow(next!, 'w1')
		expect(removed?.windows.map((window) => window.id)).toEqual(['w2'])
	})

	it('rejects stale locations and reused split identities without removing the source tab', () => {
		const original = layout(split('s0', group('g1', ['a', 'b']), group('g2', ['c'])))
		for (const action of [
			move({ sourceWindowId: 'missing' }),
			move({ sourceGroupId: 'g2' }),
			move({ targetGroupId: 'missing' }),
			move({ newSplitId: 's0', newGroupId: 'fresh' }),
			move({ newSplitId: 'fresh', newGroupId: 'g2' }),
			move({ newSplitId: 'same', newGroupId: 'same' }),
			move({ position: 'center', index: Number.NaN }),
		])
			expect(moveWorkspaceTab(original, action)).toBeNull()
		expect(locateWorkspaceTab(original, 'a')).toEqual({ windowId: 'w1', groupId: 'g1', index: 0 })
	})

	it('uses original insertion boundaries for reordering and keeps admitted no-ops revision-stable', () => {
		const original = layout()
		const next = moveWorkspaceTab(original, move({ position: 'center', index: 3 }))
		expect(next?.windows[0]?.root).toEqual(group('g1', ['b', 'c', 'a'], 'a'))
		expect(moveWorkspaceTab(original, move({ position: 'center', index: 1 }))).toBe(original)
		expect(activateWorkspaceTab(original, { windowId: 'w1', groupId: 'g1', tabId: 'a' })).toBe(
			original,
		)
		const singleton = layout(group('g1', ['a']))
		expect(moveWorkspaceTab(singleton, move())).toBe(singleton)
	})

	it('closes only a view tab, choosing the right neighbor then previous neighbor and collapsing empty groups', () => {
		const initial = layout(group('g1', ['a', 'b', 'c'], 'b'))
		const next = closeWorkspaceTab(initial, { windowId: 'w1', groupId: 'g1', tabId: 'b' })!
		expect(next.windows[0]?.root).toEqual(group('g1', ['a', 'c'], 'c'))
		const last = closeWorkspaceTab(next, { windowId: 'w1', groupId: 'g1', tabId: 'c' })!
		expect(last.windows[0]?.root).toEqual(group('g1', ['a']))
		const empty = closeWorkspaceTab(last, { windowId: 'w1', groupId: 'g1', tabId: 'a' })!
		expect(empty.windows[0]).toMatchObject({ root: null, focusedGroupId: null })
		expect(closeWorkspaceTab(empty, { windowId: 'w1', groupId: 'g1', tabId: 'a' })).toBeNull()
	})

	it('opens and selects existing group tabs without permitting a duplicated conversation view', () => {
		const empty = createWorkspaceLayout('w1')
		const first = openWorkspaceTab(empty, { windowId: 'w1', tabId: 'a', newGroupId: 'g1' })!
		const next = openWorkspaceTab(first, { windowId: 'w1', tabId: 'b', index: 0 })!
		expect(next.windows[0]?.root).toEqual(group('g1', ['b', 'a'], 'b'))
		const selected = activateWorkspaceTab(next, { windowId: 'w1', groupId: 'g1', tabId: 'a' })!
		expect(selected.windows[0]?.root).toEqual(group('g1', ['b', 'a'], 'a'))
		expect(openWorkspaceTab(selected, { windowId: 'w1', tabId: 'a' })).toBeNull()
		expect(openWorkspaceTab(selected, { windowId: 'w1', tabId: 'c', groupId: 'absent' })).toBeNull()
		expect(activateWorkspaceTab(selected, { windowId: 'w1', groupId: 'g1', tabId: 'c' })).toBeNull()
		expect(removeWorkspaceWindow(selected, 'w1')).toBeNull()
	})

	it('never removes a populated native window or duplicates an existing window', () => {
		const initial = layout()
		expect(addWorkspaceWindow(initial, { id: 'w1' })).toBeNull()
		const two = addWorkspaceWindow(initial, {
			id: 'w2',
			bounds: { x: 10, y: 20, width: 900, height: 700 },
		})!
		expect(removeWorkspaceWindow(two, 'w1')).toBeNull()
		expect(removeWorkspaceWindow(two, 'w2')?.windows).toEqual(initial.windows)
	})

	it('rejects revision overflow rather than publishing an imprecise generation', () => {
		const initial = { ...layout(), revision: Number.MAX_SAFE_INTEGER }
		expect(closeWorkspaceTab(initial, { windowId: 'w1', groupId: 'g1', tabId: 'a' })).toBeNull()
	})
})

describe('workspace usable pane geometry', () => {
	it('composes recursive minimum dimensions in each split direction', () => {
		const tree = split(
			'outer',
			group('left', ['a']),
			split('inner', group('top', ['b']), group('bottom', ['c']), 'vertical'),
		)
		expect(workspaceMinimumSize(tree)).toEqual({ width: 764, height: 604 })
		expect(workspaceMinimumSize(null)).toEqual({ width: 0, height: 0 })
	})

	it('gates new splits by the target pane size, including nested direction and gutter', () => {
		const tree = split('s1', group('g1', ['a']), group('g2', ['b']))
		expect(workspaceGroupSize(tree, 'g1', { width: 1600, height: 800 })).toEqual({
			width: 798,
			height: 800,
		})
		expect(workspaceSplitFits(tree, 'g1', 'right', { width: 1600, height: 800 })).toBe(true)
		expect(workspaceSplitFits(tree, 'g1', 'bottom', { width: 1600, height: 800 })).toBe(true)
		expect(workspaceSplitFits(tree, 'g1', 'right', { width: 1200, height: 800 })).toBe(false)
		expect(workspaceSplitFits(tree, 'missing', 'center', { width: 1600, height: 800 })).toBe(false)
		expect(workspaceSplitFits(tree, 'g1', 'right', { width: Number.NaN, height: 800 })).toBe(false)
		expect(
			workspaceSplitFits(
				tree,
				'g1',
				'right',
				{ width: 1600, height: 800 },
				{ width: 0, height: 300 },
			),
		).toBe(false)
	})

	it('clamps a restored thin pane to the same readable geometry as the renderer', () => {
		const tree = split('s1', group('g1', ['a']), group('g2', ['b']), 'horizontal', 0.01)
		expect(workspaceGroupSize(tree, 'g1', { width: 2000, height: 800 })?.width).toBeCloseTo(380)
		expect(workspaceGroupSize(tree, 'g2', { width: 2000, height: 800 })?.width).toBeCloseTo(1616)
		expect(workspaceSplitFits(tree, 'g1', 'right', { width: 2000, height: 800 })).toBe(false)
		expect(workspaceGroupSize(tree, 'g1', { width: 700, height: 800 })).toBeNull()
	})

	it('constrains resize ratios by both recursive branches, refusing impossible containers', () => {
		const tree = split(
			's1',
			group('g1', ['a']),
			split('s2', group('g2', ['b']), group('g3', ['c'])),
		)
		expect(constrainWorkspaceSplitRatio(tree, 0, { width: 1600, height: 800 })).toBeCloseTo(
			380 / 1596,
		)
		expect(constrainWorkspaceSplitRatio(tree, 1, { width: 1600, height: 800 })).toBeCloseTo(
			1 - 764 / 1596,
		)
		expect(constrainWorkspaceSplitRatio(tree, 0.5, { width: 1100, height: 800 })).toBeNull()
		expect(constrainWorkspaceSplitRatio(tree, 0.5, { width: 1600, height: 299 })).toBeNull()
		expect(constrainWorkspaceSplitRatio(tree, Number.NaN, { width: 1600, height: 800 })).toBeNull()
		const initial = layout(tree)
		expect(resizeWorkspaceSplit(initial, { windowId: 'w1', splitId: 's1', ratio: 0.5 })).toBe(
			initial,
		)
		expect(
			resizeWorkspaceSplit(initial, { windowId: 'w1', splitId: 's1', ratio: 0.4 })?.revision,
		).toBe(8)
		expect(resizeWorkspaceSplit(initial, { windowId: 'w1', splitId: 's1', ratio: 0 })).toBeNull()
		expect(resizeWorkspaceSplit(initial, { windowId: 'w1', splitId: 'g1', ratio: 0.4 })).toBeNull()
	})

	it('rejects an edge transfer that would create an unreadable destination without changing ownership', () => {
		const original = layout()
		expect(moveWorkspaceTab(original, move({ targetSize: { width: 763, height: 800 } }))).toBeNull()
		expect(
			moveWorkspaceTab(original, move({ targetSize: { width: 764, height: 300 } })),
		).not.toBeNull()
		expect(locateWorkspaceTab(original, 'a')?.groupId).toBe('g1')
	})

	it('supports more than eight panes when the available area satisfies the readable minimums', () => {
		let current = layout(
			group(
				'g0',
				Array.from({ length: 12 }, (_, index) => `tab${index}`),
			),
		)
		const size = { width: 3200, height: 1600 }
		for (let index = 1; index < 12; index++) {
			const candidates = workspaceGroups(current.windows[0]!.root)
				.map((pane) => ({
					pane,
					size: workspaceGroupSize(current.windows[0]!.root, pane.id, size)!,
				}))
				.sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)
			const target = candidates.find(({ pane, size: paneSize }) =>
				workspaceSplitFits(
					current.windows[0]!.root,
					pane.id,
					paneSize.width / 380 > paneSize.height / 300 ? 'right' : 'bottom',
					size,
				),
			)!
			const position = target.size.width / 380 > target.size.height / 300 ? 'right' : 'bottom'
			current = moveWorkspaceTab(current, {
				tabId: `tab${index}`,
				sourceWindowId: 'w1',
				sourceGroupId: 'g0',
				targetWindowId: 'w1',
				targetGroupId: target.pane.id,
				position,
				newGroupId: `g${index}`,
				newSplitId: `s${index}`,
				targetSize: size,
			})!
			expect(current).not.toBeNull()
		}
		expect(workspaceGroups(current.windows[0]!.root)).toHaveLength(12)
		expect(parseWorkspaceLayout(current)).toEqual(current)
		for (const pane of workspaceGroups(current.windows[0]!.root)) {
			const physical = workspaceGroupSize(current.windows[0]!.root, pane.id, size)!
			expect(physical.width).toBeGreaterThanOrEqual(380)
			expect(physical.height).toBeGreaterThanOrEqual(300)
		}
	})
})
