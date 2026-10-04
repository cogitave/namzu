/** A view layout owns tab placement; it never starts or stops a conversation runtime. */
export interface WorkspaceGroup {
	kind: 'group'
	id: string
	tabs: string[]
	activeTabId: string
}

export interface WorkspaceSplit {
	kind: 'split'
	id: string
	/** Horizontal places first on the left; vertical places first above second. */
	direction: 'horizontal' | 'vertical'
	ratio: number
	first: WorkspaceNode
	second: WorkspaceNode
}

export type WorkspaceNode = WorkspaceGroup | WorkspaceSplit

export interface WorkspaceSize {
	width: number
	height: number
}

export interface WorkspaceBounds extends WorkspaceSize {
	x: number
	y: number
}

export type WorkspaceWindowBounds = WorkspaceBounds

export interface WorkspaceWindowLayout {
	id: string
	root: WorkspaceNode | null
	focusedGroupId: string | null
	bounds?: WorkspaceBounds
}

export interface WorkspaceLayoutSnapshot {
	version: 1
	revision: number
	windows: WorkspaceWindowLayout[]
}

export type WorkspaceDropPosition = 'center' | 'left' | 'right' | 'top' | 'bottom'

export interface WorkspaceTabLocation {
	windowId: string
	groupId: string
	index: number
}

export interface WorkspaceMoveTab {
	tabId: string
	sourceWindowId: string
	sourceGroupId: string
	targetWindowId: string
	targetGroupId: string
	position: WorkspaceDropPosition
	/** Insertion boundary in the destination's original tab list, before removal. */
	index?: number
	/** Caller supplies fresh IDs for an edge split; the model never generates identities. */
	newGroupId?: string
	newSplitId?: string
	/** Whole destination workspace size, supplied by the owner of the native window. */
	targetSize?: WorkspaceSize
}

export interface WorkspaceOpenTab {
	windowId: string
	tabId: string
	groupId?: string
	newGroupId?: string
	index?: number
}

export interface WorkspaceTabTarget {
	windowId: string
	groupId: string
	tabId: string
}

export const WORKSPACE_PANE_MINIMUM: Readonly<WorkspaceSize> = { width: 380, height: 300 }
export const WORKSPACE_DIVIDER_SIZE = 4

// These bounds protect the persisted/IPC parser from oversized or recursive input.
// They are deliberately independent of a screen's usable number of panes.
const MAX_WINDOWS = 64
const MAX_NODES = 4096
const MAX_TABS = 16384
const MAX_DEPTH = 64
const MIN_RATIO = 0.01
const MAX_RATIO = 0.99

const validId = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= 256 &&
	value.trim() === value &&
	!Array.from(value).some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const validSize = (value: WorkspaceSize): boolean =>
	Number.isFinite(value.width) &&
	Number.isFinite(value.height) &&
	value.width > 0 &&
	value.height > 0

const validRatio = (ratio: unknown): ratio is number =>
	typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= MIN_RATIO && ratio <= MAX_RATIO

const parseBounds = (value: unknown): WorkspaceBounds | null => {
	if (!record(value)) return null
	const { x, y, width, height } = value
	if (
		typeof x !== 'number' ||
		typeof y !== 'number' ||
		typeof width !== 'number' ||
		typeof height !== 'number' ||
		![x, y, width, height].every(Number.isSafeInteger) ||
		width <= 0 ||
		height <= 0
	)
		return null
	return { x, y, width, height }
}

/** Reject malformed persisted input rather than silently assigning two writers to a tab. */
export const parseWorkspaceLayout = (value: unknown): WorkspaceLayoutSnapshot | null => {
	if (
		!record(value) ||
		value.version !== 1 ||
		typeof value.revision !== 'number' ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		!Array.isArray(value.windows) ||
		value.windows.length === 0 ||
		value.windows.length > MAX_WINDOWS
	)
		return null

	const windowIds = new Set<string>()
	const nodeIds = new Set<string>()
	const tabIds = new Set<string>()
	let nodeCount = 0
	const parseNode = (input: unknown, depth: number): WorkspaceNode | null => {
		if (
			depth > MAX_DEPTH ||
			!record(input) ||
			!validId(input.id) ||
			nodeIds.has(input.id) ||
			++nodeCount > MAX_NODES
		)
			return null
		nodeIds.add(input.id)
		if (input.kind === 'group') {
			if (!Array.isArray(input.tabs) || input.tabs.length === 0 || !validId(input.activeTabId))
				return null
			const tabs: string[] = []
			for (const tabId of input.tabs) {
				if (!validId(tabId) || tabIds.has(tabId) || tabIds.size >= MAX_TABS) return null
				tabIds.add(tabId)
				tabs.push(tabId)
			}
			if (!tabs.includes(input.activeTabId)) return null
			return { kind: 'group', id: input.id, tabs, activeTabId: input.activeTabId }
		}
		if (
			input.kind !== 'split' ||
			(input.direction !== 'horizontal' && input.direction !== 'vertical') ||
			!validRatio(input.ratio)
		)
			return null
		const first = parseNode(input.first, depth + 1)
		if (!first) return null
		const second = parseNode(input.second, depth + 1)
		if (!second) return null
		return {
			kind: 'split',
			id: input.id,
			direction: input.direction,
			ratio: input.ratio,
			first,
			second,
		}
	}
	const windows: WorkspaceWindowLayout[] = []
	for (const input of value.windows) {
		if (!record(input) || !validId(input.id) || windowIds.has(input.id)) return null
		windowIds.add(input.id)
		const root = input.root === null ? null : parseNode(input.root, 0)
		if (input.root !== null && !root) return null
		if (
			(root === null && input.focusedGroupId !== null) ||
			(root !== null &&
				(!validId(input.focusedGroupId) || !findWorkspaceGroup(root, input.focusedGroupId)))
		)
			return null
		const bounds = input.bounds === undefined ? undefined : parseBounds(input.bounds)
		if (bounds === null) return null
		windows.push({
			id: input.id,
			root,
			focusedGroupId: input.focusedGroupId as string | null,
			...(bounds ? { bounds } : {}),
		})
	}
	return { version: 1, revision: value.revision, windows }
}

export const createWorkspaceLayout = (
	windowId: string,
	bounds?: WorkspaceBounds,
): WorkspaceLayoutSnapshot => {
	if (!validId(windowId) || (bounds !== undefined && !parseBounds(bounds)))
		throw new Error('Invalid workspace window')
	return {
		version: 1,
		revision: 0,
		windows: [
			{
				id: windowId,
				root: null,
				focusedGroupId: null,
				...(bounds ? { bounds: { ...bounds } } : {}),
			},
		],
	}
}

export const workspaceGroups = (root: WorkspaceNode | null): WorkspaceGroup[] => {
	if (!root) return []
	if (root.kind === 'group') return [root]
	return [...workspaceGroups(root.first), ...workspaceGroups(root.second)]
}

export const findWorkspaceGroup = (
	root: WorkspaceNode | null,
	groupId: string,
): WorkspaceGroup | null => {
	if (!root) return null
	if (root.kind === 'group') return root.id === groupId ? root : null
	return findWorkspaceGroup(root.first, groupId) ?? findWorkspaceGroup(root.second, groupId)
}

export const locateWorkspaceTab = (
	layout: WorkspaceLayoutSnapshot,
	tabId: string,
): WorkspaceTabLocation | null => {
	for (const window of layout.windows) {
		for (const group of workspaceGroups(window.root)) {
			const index = group.tabs.indexOf(tabId)
			if (index !== -1) return { windowId: window.id, groupId: group.id, index }
		}
	}
	return null
}

const hasNodeId = (layout: WorkspaceLayoutSnapshot, id: string): boolean => {
	const has = (node: WorkspaceNode | null): boolean =>
		!!node && (node.id === id || (node.kind === 'split' && (has(node.first) || has(node.second))))
	return layout.windows.some((window) => has(window.root))
}

const replaceNode = (
	root: WorkspaceNode | null,
	nodeId: string,
	update: (node: WorkspaceNode) => WorkspaceNode | null,
): WorkspaceNode | null => {
	if (!root) return null
	if (root.id === nodeId) return update(root)
	if (root.kind === 'group') return root
	const first = replaceNode(root.first, nodeId, update)
	const second = replaceNode(root.second, nodeId, update)
	if (!first) return second
	if (!second) return first
	if (first === root.first && second === root.second) return root
	return { ...root, first, second }
}

const withRoot = (
	window: WorkspaceWindowLayout,
	root: WorkspaceNode | null,
	focus = window.focusedGroupId,
): WorkspaceWindowLayout => ({
	...window,
	root,
	focusedGroupId: root
		? focus && findWorkspaceGroup(root, focus)
			? focus
			: (workspaceGroups(root)[0]?.id ?? null)
		: null,
})

const changed = (
	layout: WorkspaceLayoutSnapshot,
	windows: WorkspaceWindowLayout[],
): WorkspaceLayoutSnapshot | null => {
	if (layout.revision >= Number.MAX_SAFE_INTEGER) return null
	const next = { ...layout, revision: layout.revision + 1, windows }
	return parseWorkspaceLayout(next) ? next : null
}

export const addWorkspaceWindow = (
	layout: WorkspaceLayoutSnapshot,
	window: { id: string; bounds?: WorkspaceBounds },
): WorkspaceLayoutSnapshot | null => {
	if (
		!validId(window.id) ||
		layout.windows.some((candidate) => candidate.id === window.id) ||
		layout.windows.length >= MAX_WINDOWS ||
		(window.bounds !== undefined && !parseBounds(window.bounds))
	)
		return null
	return changed(layout, [
		...layout.windows,
		{
			id: window.id,
			root: null,
			focusedGroupId: null,
			...(window.bounds ? { bounds: { ...window.bounds } } : {}),
		},
	])
}

/** Closing a native view cannot discard tabs: transfer them before removing its window. */
export const removeWorkspaceWindow = (
	layout: WorkspaceLayoutSnapshot,
	windowId: string,
): WorkspaceLayoutSnapshot | null => {
	const window = layout.windows.find((candidate) => candidate.id === windowId)
	if (!window || window.root || layout.windows.length === 1) return null
	return changed(
		layout,
		layout.windows.filter((candidate) => candidate.id !== windowId),
	)
}

export const openWorkspaceTab = (
	layout: WorkspaceLayoutSnapshot,
	input: WorkspaceOpenTab,
): WorkspaceLayoutSnapshot | null => {
	if (!validId(input.tabId) || locateWorkspaceTab(layout, input.tabId)) return null
	const window = layout.windows.find((candidate) => candidate.id === input.windowId)
	if (!window) return null
	const groupId = input.groupId ?? window.focusedGroupId
	let root: WorkspaceNode
	let focus: string
	if (!window.root) {
		if (
			!validId(input.newGroupId) ||
			hasNodeId(layout, input.newGroupId) ||
			(input.index !== undefined && input.index !== 0)
		)
			return null
		root = {
			kind: 'group',
			id: input.newGroupId,
			tabs: [input.tabId],
			activeTabId: input.tabId,
		}
		focus = input.newGroupId
	} else {
		if (!groupId) return null
		const group = findWorkspaceGroup(window.root, groupId)
		if (!group) return null
		const index = input.index ?? group.tabs.length
		if (!Number.isInteger(index) || index < 0 || index > group.tabs.length) return null
		const tabs = [...group.tabs]
		tabs.splice(index, 0, input.tabId)
		root = replaceNode(window.root, group.id, () => ({
			...group,
			tabs,
			activeTabId: input.tabId,
		})) as WorkspaceNode
		focus = group.id
	}
	return changed(
		layout,
		layout.windows.map((candidate) =>
			candidate === window ? withRoot(window, root, focus) : candidate,
		),
	)
}

const withoutTab = (group: WorkspaceGroup, tabId: string): WorkspaceGroup | null => {
	const index = group.tabs.indexOf(tabId)
	const tabs = group.tabs.filter((id) => id !== tabId)
	if (!tabs.length) return null
	return {
		...group,
		tabs,
		activeTabId:
			group.activeTabId === tabId
				? (tabs[Math.min(index, tabs.length - 1)] as string)
				: group.activeTabId,
	}
}

export const closeWorkspaceTab = (
	layout: WorkspaceLayoutSnapshot,
	input: WorkspaceTabTarget,
): WorkspaceLayoutSnapshot | null => {
	const window = layout.windows.find((candidate) => candidate.id === input.windowId)
	const group = window && findWorkspaceGroup(window.root, input.groupId)
	if (!window || !group?.tabs.includes(input.tabId)) return null
	const root = replaceNode(window.root, group.id, () => withoutTab(group, input.tabId))
	return changed(
		layout,
		layout.windows.map((candidate) => (candidate === window ? withRoot(window, root) : candidate)),
	)
}

export const activateWorkspaceTab = (
	layout: WorkspaceLayoutSnapshot,
	input: WorkspaceTabTarget,
): WorkspaceLayoutSnapshot | null => {
	const window = layout.windows.find((candidate) => candidate.id === input.windowId)
	const group = window && findWorkspaceGroup(window.root, input.groupId)
	if (!window || !group?.tabs.includes(input.tabId)) return null
	if (group.activeTabId === input.tabId && window.focusedGroupId === group.id) return layout
	const root = replaceNode(window.root, group.id, () => ({ ...group, activeTabId: input.tabId }))
	return changed(
		layout,
		layout.windows.map((candidate) =>
			candidate === window ? withRoot(window, root, group.id) : candidate,
		),
	)
}

export const resizeWorkspaceSplit = (
	layout: WorkspaceLayoutSnapshot,
	input: { windowId: string; splitId: string; ratio: number },
): WorkspaceLayoutSnapshot | null => {
	if (!validRatio(input.ratio)) return null
	const window = layout.windows.find((candidate) => candidate.id === input.windowId)
	if (!window) return null
	let found = false
	const root = replaceNode(window.root, input.splitId, (node) => {
		if (node.kind !== 'split') return node
		found = true
		return node.ratio === input.ratio ? node : { ...node, ratio: input.ratio }
	})
	if (!found) return null
	if (root === window.root) return layout
	return changed(
		layout,
		layout.windows.map((candidate) => (candidate === window ? withRoot(window, root) : candidate)),
	)
}

export const moveWorkspaceTab = (
	layout: WorkspaceLayoutSnapshot,
	input: WorkspaceMoveTab,
): WorkspaceLayoutSnapshot | null => {
	const source = layout.windows.find((window) => window.id === input.sourceWindowId)
	const target = layout.windows.find((window) => window.id === input.targetWindowId)
	const sourceGroup = source && findWorkspaceGroup(source.root, input.sourceGroupId)
	const targetGroup = target && findWorkspaceGroup(target.root, input.targetGroupId)
	if (!source || !target || !sourceGroup?.tabs.includes(input.tabId)) return null
	if (!['center', 'left', 'right', 'top', 'bottom'].includes(input.position)) return null
	if (!target.root) {
		if (
			input.position !== 'center' ||
			!validId(input.targetGroupId) ||
			hasNodeId(layout, input.targetGroupId) ||
			(input.index !== undefined && input.index !== 0)
		)
			return null
		const root: WorkspaceGroup = {
			kind: 'group',
			id: input.targetGroupId,
			tabs: [input.tabId],
			activeTabId: input.tabId,
		}
		return changed(
			layout,
			layout.windows.map((window) => {
				if (window === target) return withRoot(window, root, root.id)
				if (window === source)
					return withRoot(
						window,
						replaceNode(window.root, sourceGroup.id, () => withoutTab(sourceGroup, input.tabId)),
					)
				return window
			}),
		)
	}
	if (!targetGroup) return null
	const sameGroup = sourceGroup === targetGroup
	if (sameGroup && sourceGroup.tabs.length === 1) return layout
	const index = input.index ?? targetGroup.tabs.length
	if (!Number.isInteger(index) || index < 0 || index > targetGroup.tabs.length) return null
	if (input.position !== 'center') {
		if (
			!validId(input.newGroupId) ||
			!validId(input.newSplitId) ||
			input.newGroupId === input.newSplitId ||
			hasNodeId(layout, input.newGroupId) ||
			hasNodeId(layout, input.newSplitId) ||
			(input.targetSize !== undefined &&
				!workspaceSplitFits(target.root, targetGroup.id, input.position, input.targetSize))
		)
			return null
	}

	const sourceRoot = replaceNode(source.root, sourceGroup.id, () =>
		withoutTab(sourceGroup, input.tabId),
	)
	let targetRoot = source === target ? sourceRoot : target.root
	// The destination group remains after source removal, except the admitted single-tab no-op above.
	const destination = findWorkspaceGroup(targetRoot, targetGroup.id)
	if (!destination) return null
	if (input.position === 'center') {
		const tabs = [...destination.tabs]
		const insertion = index - (sameGroup && sourceGroup.tabs.indexOf(input.tabId) < index ? 1 : 0)
		tabs.splice(insertion, 0, input.tabId)
		if (
			sameGroup &&
			tabs.every((id, offset) => id === sourceGroup.tabs[offset]) &&
			sourceGroup.activeTabId === input.tabId &&
			source.focusedGroupId === sourceGroup.id
		)
			return layout
		targetRoot = replaceNode(targetRoot, destination.id, () => ({
			...destination,
			tabs,
			activeTabId: input.tabId,
		}))
	} else {
		const group: WorkspaceGroup = {
			kind: 'group',
			id: input.newGroupId as string,
			tabs: [input.tabId],
			activeTabId: input.tabId,
		}
		const before = input.position === 'left' || input.position === 'top'
		targetRoot = replaceNode(targetRoot, destination.id, () => ({
			kind: 'split',
			id: input.newSplitId as string,
			direction:
				input.position === 'left' || input.position === 'right' ? 'horizontal' : 'vertical',
			ratio: 0.5,
			first: before ? group : destination,
			second: before ? destination : group,
		}))
	}
	const focusedGroupId = input.position === 'center' ? destination.id : (input.newGroupId as string)
	return changed(
		layout,
		layout.windows.map((window) => {
			if (window === target) return withRoot(window, targetRoot, focusedGroupId)
			if (window === source) return withRoot(window, sourceRoot)
			return window
		}),
	)
}

export const workspaceMinimumSize = (
	root: WorkspaceNode | null,
	minimum: Readonly<WorkspaceSize> = WORKSPACE_PANE_MINIMUM,
	divider = WORKSPACE_DIVIDER_SIZE,
): WorkspaceSize => {
	if (!root) return { width: 0, height: 0 }
	if (root.kind === 'group') return { ...minimum }
	const first = workspaceMinimumSize(root.first, minimum, divider)
	const second = workspaceMinimumSize(root.second, minimum, divider)
	return root.direction === 'horizontal'
		? { width: first.width + second.width + divider, height: Math.max(first.height, second.height) }
		: { width: Math.max(first.width, second.width), height: first.height + second.height + divider }
}

/** Find the usable size of an existing pane under the tree's current split ratios. */
export const workspaceGroupSize = (
	root: WorkspaceNode | null,
	groupId: string,
	size: WorkspaceSize,
	divider = WORKSPACE_DIVIDER_SIZE,
	minimum: Readonly<WorkspaceSize> = WORKSPACE_PANE_MINIMUM,
): WorkspaceSize | null => {
	if (!root || !validSize(size) || !validSize(minimum) || !Number.isFinite(divider) || divider < 0)
		return null
	if (root.kind === 'group') return root.id === groupId ? { ...size } : null
	const horizontal = root.direction === 'horizontal'
	const length = (horizontal ? size.width : size.height) - divider
	if (length <= 0) return null
	const ratio = constrainWorkspaceSplitRatio(root, root.ratio, size, minimum, divider)
	if (ratio === null) return null
	const first = horizontal
		? { width: length * ratio, height: size.height }
		: { width: size.width, height: length * ratio }
	const second = horizontal
		? { width: length * (1 - ratio), height: size.height }
		: { width: size.width, height: length * (1 - ratio) }
	return (
		workspaceGroupSize(root.first, groupId, first, divider, minimum) ??
		workspaceGroupSize(root.second, groupId, second, divider, minimum)
	)
}

export const workspaceSplitFits = (
	root: WorkspaceNode | null,
	groupId: string,
	position: WorkspaceDropPosition,
	size: WorkspaceSize,
	minimum: Readonly<WorkspaceSize> = WORKSPACE_PANE_MINIMUM,
	divider = WORKSPACE_DIVIDER_SIZE,
): boolean => {
	if (!validSize(minimum) || !Number.isFinite(divider) || divider < 0) return false
	const group = workspaceGroupSize(root, groupId, size, divider, minimum)
	if (!group) return false
	if (position === 'center') return true
	if (position === 'left' || position === 'right')
		return group.width >= minimum.width * 2 + divider && group.height >= minimum.height
	if (position === 'top' || position === 'bottom')
		return group.width >= minimum.width && group.height >= minimum.height * 2 + divider
	return false
}

/** Null means the container cannot satisfy both branches' readable minimums. */
export const constrainWorkspaceSplitRatio = (
	split: WorkspaceSplit,
	ratio: number,
	size: WorkspaceSize,
	minimum: Readonly<WorkspaceSize> = WORKSPACE_PANE_MINIMUM,
	divider = WORKSPACE_DIVIDER_SIZE,
): number | null => {
	if (
		!Number.isFinite(ratio) ||
		!validSize(size) ||
		!validSize(minimum) ||
		!Number.isFinite(divider) ||
		divider < 0
	)
		return null
	const first = workspaceMinimumSize(split.first, minimum, divider)
	const second = workspaceMinimumSize(split.second, minimum, divider)
	const horizontal = split.direction === 'horizontal'
	const length = (horizontal ? size.width : size.height) - divider
	const cross = horizontal ? size.height : size.width
	const firstLength = horizontal ? first.width : first.height
	const secondLength = horizontal ? second.width : second.height
	if (
		length <= 0 ||
		length < firstLength + secondLength ||
		cross <
			Math.max(horizontal ? first.height : first.width, horizontal ? second.height : second.width)
	)
		return null
	const lower = Math.max(MIN_RATIO, firstLength / length)
	const upper = Math.min(MAX_RATIO, 1 - secondLength / length)
	if (lower > upper) return null
	return Math.min(upper, Math.max(lower, ratio))
}
