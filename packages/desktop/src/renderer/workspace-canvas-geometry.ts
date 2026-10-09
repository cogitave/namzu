import {
	WORKSPACE_DIVIDER_SIZE,
	WORKSPACE_PANE_MINIMUM,
	type WorkspaceDropPosition,
	type WorkspaceGroup,
	type WorkspaceNode,
	type WorkspaceSize,
	type WorkspaceSplit,
	constrainWorkspaceSplitRatio,
	workspaceMinimumSize,
} from '../shared/workspace-layout.js'

export const WORKSPACE_TAB_DRAG_MIME = 'application/x-namzu-tab'

export interface WorkspaceTabDrag {
	windowId: string
	groupId: string
	tabId: string
}

const validDragId = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= 256 &&
	value.trim() === value &&
	Array.from(value).every(
		(character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
	)

/** Drag data is an identity hint. Main still checks the actual conversation owner. */
export function parseWorkspaceTabDrag(raw: string): WorkspaceTabDrag | null {
	if (raw.length > 2048) return null
	try {
		const value: unknown = JSON.parse(raw)
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null
		const input = value as Record<string, unknown>
		if (
			Object.keys(input).some((key) => !['windowId', 'groupId', 'tabId'].includes(key)) ||
			!validDragId(input.windowId) ||
			!validDragId(input.groupId) ||
			!validDragId(input.tabId)
		)
			return null
		return { windowId: input.windowId, groupId: input.groupId, tabId: input.tabId }
	} catch {
		return null
	}
}

export function createWorkspaceTabDrag(source: WorkspaceTabDrag): string {
	const raw = JSON.stringify(source)
	if (!parseWorkspaceTabDrag(raw)) throw new Error('Invalid conversation tab drag.')
	return raw
}

/** Native drag cancellation commonly reports (0, 0); accepted drops must never detach again. */
export function workspaceDragEndsOutsideWindow(input: {
	x: number
	y: number
	dropEffect: string
	cancelled: boolean
	window: WorkspaceRect
}): boolean {
	const { x, y, dropEffect, cancelled, window } = input
	if (
		cancelled ||
		dropEffect !== 'none' ||
		(x === 0 && y === 0) ||
		![x, y, window.x, window.y, window.width, window.height].every(Number.isFinite) ||
		window.width <= 0 ||
		window.height <= 0
	)
		return false
	return (
		x < window.x || y < window.y || x >= window.x + window.width || y >= window.y + window.height
	)
}

export interface WorkspaceRect extends WorkspaceSize {
	x: number
	y: number
}

export interface WorkspaceGroupRect {
	group: WorkspaceGroup
	rect: WorkspaceRect
}

export interface WorkspaceDividerRect {
	split: WorkspaceSplit
	container: WorkspaceRect
	rect: WorkspaceRect
	ratio: number
	minimumRatio: number
	maximumRatio: number
}

export interface WorkspaceGeometry extends WorkspaceSize {
	groups: WorkspaceGroupRect[]
	dividers: WorkspaceDividerRect[]
}

/** Flat group siblings retain their React identity when a split wraps or collapses their tree. */
export function workspaceGeometry(
	root: WorkspaceNode | null,
	viewport: WorkspaceSize,
	ratios: Readonly<Record<string, number>> = {},
): WorkspaceGeometry {
	const minimum = workspaceMinimumSize(root)
	const geometry: WorkspaceGeometry = {
		width: Math.max(minimum.width, Number.isFinite(viewport.width) ? viewport.width : 0),
		height: Math.max(minimum.height, Number.isFinite(viewport.height) ? viewport.height : 0),
		groups: [],
		dividers: [],
	}
	const visit = (node: WorkspaceNode, rect: WorkspaceRect): void => {
		if (node.kind === 'group') {
			geometry.groups.push({ group: node, rect })
			return
		}
		const desired = ratios[node.id] ?? node.ratio
		const ratio =
			constrainWorkspaceSplitRatio(node, desired, rect) ??
			constrainWorkspaceSplitRatio(node, node.ratio, rect) ??
			node.ratio
		const horizontal = node.direction === 'horizontal'
		const length = (horizontal ? rect.width : rect.height) - WORKSPACE_DIVIDER_SIZE
		const firstLength = length * ratio
		const secondLength = length - firstLength
		const first: WorkspaceRect = horizontal
			? { ...rect, width: firstLength }
			: { ...rect, height: firstLength }
		const divider: WorkspaceRect = horizontal
			? { ...rect, x: rect.x + firstLength, width: WORKSPACE_DIVIDER_SIZE }
			: { ...rect, y: rect.y + firstLength, height: WORKSPACE_DIVIDER_SIZE }
		const second: WorkspaceRect = horizontal
			? { ...rect, x: divider.x + WORKSPACE_DIVIDER_SIZE, width: secondLength }
			: { ...rect, y: divider.y + WORKSPACE_DIVIDER_SIZE, height: secondLength }
		geometry.dividers.push({
			split: node,
			container: rect,
			rect: divider,
			ratio,
			minimumRatio: constrainWorkspaceSplitRatio(node, 0, rect) ?? ratio,
			maximumRatio: constrainWorkspaceSplitRatio(node, 1, rect) ?? ratio,
		})
		visit(node.first, first)
		visit(node.second, second)
	}
	if (root) visit(root, { x: 0, y: 0, width: geometry.width, height: geometry.height })
	return geometry
}

/** Pointer coordinates are relative to the scrollable canvas, including its scroll offset. */
export function workspacePointerRatio(divider: WorkspaceDividerRect, x: number, y: number): number {
	const horizontal = divider.split.direction === 'horizontal'
	const pointer = horizontal ? x : y
	const start = horizontal ? divider.container.x : divider.container.y
	const length =
		(horizontal ? divider.container.width : divider.container.height) - WORKSPACE_DIVIDER_SIZE
	if (!Number.isFinite(pointer) || length <= 0) return divider.ratio
	const ratio = (pointer - start - WORKSPACE_DIVIDER_SIZE / 2) / length
	return Math.max(divider.minimumRatio, Math.min(divider.maximumRatio, ratio))
}

export function workspacePaneSplitFits(
	rect: WorkspaceSize,
	position: WorkspaceDropPosition,
): boolean {
	if (position === 'center') return true
	if (position === 'left' || position === 'right')
		return (
			rect.width >= WORKSPACE_PANE_MINIMUM.width * 2 + WORKSPACE_DIVIDER_SIZE &&
			rect.height >= WORKSPACE_PANE_MINIMUM.height
		)
	return (
		rect.width >= WORKSPACE_PANE_MINIMUM.width &&
		rect.height >= WORKSPACE_PANE_MINIMUM.height * 2 + WORKSPACE_DIVIDER_SIZE
	)
}

/**
 * Whether a split made from the menu has room, and whether closing the sidebar would give it the
 * room it lacks. `canvas` is the space the panes share now; the sidebar sits beside it.
 */
export function workspaceSplitRoom(
	canvas: WorkspaceSize,
	position: 'right' | 'bottom',
	sidebarWidth: number,
): 'fits' | 'collapse-sidebar' | 'too-small' {
	if (workspacePaneSplitFits(canvas, position)) return 'fits'
	if (
		position === 'right' &&
		workspacePaneSplitFits({ ...canvas, width: canvas.width + sidebarWidth }, position)
	)
		return 'collapse-sidebar'
	return 'too-small'
}

/** Edges that cannot create two readable panes fall back to joining the target's tabs. */
export function workspacePointerDrop(
	rect: WorkspaceRect,
	x: number,
	y: number,
): WorkspaceDropPosition {
	if (
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		x < rect.x ||
		y < rect.y ||
		x > rect.x + rect.width ||
		y > rect.y + rect.height
	)
		return 'center'
	const horizontalEdge = Math.min(80, rect.width * 0.22)
	const verticalEdge = Math.min(80, rect.height * 0.22)
	const candidates: { position: WorkspaceDropPosition; distance: number }[] = [
		{ position: 'left', distance: (x - rect.x) / horizontalEdge },
		{ position: 'right', distance: (rect.x + rect.width - x) / horizontalEdge },
		{ position: 'top', distance: (y - rect.y) / verticalEdge },
		{ position: 'bottom', distance: (rect.y + rect.height - y) / verticalEdge },
	]
	const nearest = candidates
		.filter((candidate) => candidate.distance >= 0 && candidate.distance <= 1)
		.sort((first, second) => first.distance - second.distance)[0]
	return nearest && workspacePaneSplitFits(rect, nearest.position) ? nearest.position : 'center'
}

export function workspaceDropRect(
	rect: WorkspaceRect,
	position: WorkspaceDropPosition,
): WorkspaceRect {
	if (position === 'left') return { ...rect, width: (rect.width - WORKSPACE_DIVIDER_SIZE) / 2 }
	if (position === 'right') {
		const width = (rect.width - WORKSPACE_DIVIDER_SIZE) / 2
		return { ...rect, x: rect.x + rect.width - width, width }
	}
	if (position === 'top') return { ...rect, height: (rect.height - WORKSPACE_DIVIDER_SIZE) / 2 }
	if (position === 'bottom') {
		const height = (rect.height - WORKSPACE_DIVIDER_SIZE) / 2
		return { ...rect, y: rect.y + rect.height - height, height }
	}
	return { ...rect }
}
