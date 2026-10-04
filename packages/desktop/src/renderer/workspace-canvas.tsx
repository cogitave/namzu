import {
	type CSSProperties,
	type DragEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from 'react'
import type { WorkspaceAction } from '../shared/protocol.js'
import type {
	WorkspaceDropPosition,
	WorkspaceGroup,
	WorkspaceWindowLayout,
} from '../shared/workspace-layout.js'
import {
	WORKSPACE_TAB_DRAG_MIME,
	type WorkspaceDividerRect,
	type WorkspaceRect,
	type WorkspaceTabDrag,
	parseWorkspaceTabDrag,
	workspaceDropRect,
	workspaceGeometry,
	workspacePointerDrop,
	workspacePointerRatio,
} from './workspace-canvas-geometry.js'
import './workspace-canvas.css'

export interface WorkspaceCanvasProps {
	windowLayout: WorkspaceWindowLayout
	/** Keeps the initial controller mounted when its first conversation is created. */
	emptyGroupId?: string
	renderPane: (group: WorkspaceGroup) => ReactNode
	onPaneFocus: (groupId: string) => void
	onAction: (action: WorkspaceAction) => unknown
	onPrepareMove?: (source: WorkspaceTabDrag) => Promise<void>
	onError?: (error: unknown) => void
	busy?: boolean
}

const boxStyle = (rect: WorkspaceRect): CSSProperties => ({
	left: rect.x,
	top: rect.y,
	width: rect.width,
	height: rect.height,
})

const hasTabDrag = (event: DragEvent): boolean =>
	Array.from(event.dataTransfer.types).includes(WORKSPACE_TAB_DRAG_MIME)

export function WorkspaceCanvas({
	windowLayout,
	emptyGroupId,
	renderPane,
	onPaneFocus,
	onAction,
	onPrepareMove,
	onError,
	busy = false,
}: WorkspaceCanvasProps) {
	const viewport = useRef<HTMLDivElement>(null)
	const [size, setSize] = useState({ width: 0, height: 0 })
	const [ratios, setRatios] = useState<Record<string, number>>({})
	const [drop, setDrop] = useState<{ groupId: string; position: WorkspaceDropPosition }>()
	const moving = useRef(false)
	const ratioWrites = useRef<Record<string, number>>({})
	const resize = useRef<
		{ divider: WorkspaceDividerRect; pointerId: number; ratio: number } | undefined
	>(undefined)
	const root =
		windowLayout.root ??
		(emptyGroupId ? { kind: 'group' as const, id: emptyGroupId, tabs: [], activeTabId: '' } : null)
	const geometry = workspaceGeometry(root, size, ratios)

	useEffect(() => {
		const node = viewport.current
		if (!node) return
		const measure = () => {
			const next = { width: node.clientWidth, height: node.clientHeight }
			setSize((previous) =>
				previous.width === next.width && previous.height === next.height ? previous : next,
			)
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	useEffect(() => {
		const clear = () => setDrop(undefined)
		window.addEventListener('dragend', clear)
		window.addEventListener('blur', clear)
		return () => {
			window.removeEventListener('dragend', clear)
			window.removeEventListener('blur', clear)
		}
	}, [])

	const report = (error: unknown) => onError?.(error)
	const point = (clientX: number, clientY: number) => {
		const node = viewport.current
		const bounds = node?.getBoundingClientRect()
		return {
			x: clientX - (bounds?.left ?? 0) + (node?.scrollLeft ?? 0),
			y: clientY - (bounds?.top ?? 0) + (node?.scrollTop ?? 0),
		}
	}
	const clearRatio = (id: string) =>
		setRatios((current) => {
			const next = { ...current }
			delete next[id]
			return next
		})
	const commitResize = (divider: WorkspaceDividerRect, ratio: number) => {
		const generation = (ratioWrites.current[divider.split.id] ?? 0) + 1
		ratioWrites.current[divider.split.id] = generation
		setRatios((current) => ({ ...current, [divider.split.id]: ratio }))
		void Promise.resolve()
			.then(() => onAction({ kind: 'resize', splitId: divider.split.id, ratio }))
			.catch(report)
			.finally(() => {
				if (ratioWrites.current[divider.split.id] === generation) clearRatio(divider.split.id)
			})
	}
	const dragOver = (event: DragEvent<HTMLElement>, groupId: string, rect: WorkspaceRect) => {
		if (busy || moving.current || !hasTabDrag(event)) return
		// Chromium may hide data until the actual drop; the MIME type is sufficient for a preview.
		const raw = event.dataTransfer.getData(WORKSPACE_TAB_DRAG_MIME)
		if (raw && !parseWorkspaceTabDrag(raw)) return
		event.preventDefault()
		event.stopPropagation()
		event.dataTransfer.dropEffect = 'move'
		const pointer = point(event.clientX, event.clientY)
		const position = windowLayout.root ? workspacePointerDrop(rect, pointer.x, pointer.y) : 'center'
		setDrop((current) =>
			current?.groupId === groupId && current.position === position
				? current
				: { groupId, position },
		)
	}
	const receiveTab = (
		event: DragEvent<HTMLElement>,
		group: WorkspaceGroup,
		rect: WorkspaceRect,
	) => {
		if (busy || moving.current || !hasTabDrag(event)) return
		const source = parseWorkspaceTabDrag(event.dataTransfer.getData(WORKSPACE_TAB_DRAG_MIME))
		if (!source) return
		event.preventDefault()
		event.stopPropagation()
		event.dataTransfer.dropEffect = 'move'
		setDrop(undefined)
		const pointer = point(event.clientX, event.clientY)
		const position = windowLayout.root ? workspacePointerDrop(rect, pointer.x, pointer.y) : 'center'
		let index: number | undefined
		if (position === 'center' && event.target instanceof Element) {
			const tab = event.target.closest<HTMLElement>('.conversation-tab[data-tab-id]')
			const tabId = tab?.dataset.tabId
			const target = tabId ? group.tabs.indexOf(tabId) : -1
			if (tab && target !== -1) {
				const bounds = tab.getBoundingClientRect()
				index = target + (event.clientX >= bounds.left + bounds.width / 2 ? 1 : 0)
			}
		}
		moving.current = true
		void Promise.resolve()
			.then(() => onPrepareMove?.(source))
			.then(() =>
				onAction({
					kind: 'move',
					tabId: source.tabId,
					sourceWindowId: source.windowId,
					sourceGroupId: source.groupId,
					targetWindowId: windowLayout.id,
					targetGroupId: group.id,
					position,
					...(index === undefined ? {} : { index }),
					size: { width: geometry.width, height: geometry.height },
				}),
			)
			.catch(report)
			.finally(() => {
				moving.current = false
			})
	}

	return (
		<div
			ref={viewport}
			className="workspace-canvas"
			data-workspace-window={windowLayout.id}
			onDragLeave={(event) => {
				const bounds = event.currentTarget.getBoundingClientRect()
				if (
					event.clientX <= bounds.left ||
					event.clientX >= bounds.right ||
					event.clientY <= bounds.top ||
					event.clientY >= bounds.bottom
				)
					setDrop(undefined)
			}}
		>
			<div
				className="workspace-canvas-content"
				style={{ width: geometry.width, height: geometry.height }}
			>
				{geometry.groups.map(({ group, rect }, index) => (
					<section
						key={group.id}
						id={`workspace-group-${encodeURIComponent(windowLayout.id)}-${encodeURIComponent(group.id)}`}
						className="workspace-canvas-pane"
						aria-label={`Conversation group ${index + 1}`}
						data-workspace-group={group.id}
						data-focused={
							windowLayout.focusedGroupId === group.id ||
							(!windowLayout.root && group.id === emptyGroupId)
						}
						style={boxStyle(rect)}
						onFocusCapture={() => onPaneFocus(group.id)}
						onPointerDownCapture={() => onPaneFocus(group.id)}
						onDragOver={(event) => dragOver(event, group.id, rect)}
						onDrop={(event) => receiveTab(event, group, rect)}
					>
						{renderPane(group)}
					</section>
				))}
				{geometry.dividers.map((divider) => (
					<div
						key={divider.split.id}
						className="workspace-canvas-divider"
						role="separator"
						tabIndex={busy ? -1 : 0}
						aria-label={
							divider.split.direction === 'horizontal'
								? 'Resize side by side panes'
								: 'Resize stacked panes'
						}
						aria-orientation={divider.split.direction === 'horizontal' ? 'vertical' : 'horizontal'}
						aria-valuemin={Math.round(divider.minimumRatio * 100)}
						aria-valuemax={Math.round(divider.maximumRatio * 100)}
						aria-valuenow={Math.round(divider.ratio * 100)}
						data-direction={divider.split.direction}
						style={boxStyle(divider.rect)}
						onPointerDown={(event) => {
							if (busy || event.button !== 0) return
							event.preventDefault()
							event.currentTarget.focus({ preventScroll: true })
							event.currentTarget.setPointerCapture(event.pointerId)
							ratioWrites.current[divider.split.id] =
								(ratioWrites.current[divider.split.id] ?? 0) + 1
							resize.current = { divider, pointerId: event.pointerId, ratio: divider.ratio }
						}}
						onPointerMove={(event) => {
							const active = resize.current
							if (!active || active.pointerId !== event.pointerId) return
							const pointer = point(event.clientX, event.clientY)
							active.ratio = workspacePointerRatio(active.divider, pointer.x, pointer.y)
							setRatios((current) => ({ ...current, [active.divider.split.id]: active.ratio }))
						}}
						onPointerUp={(event) => {
							const active = resize.current
							if (!active || active.pointerId !== event.pointerId) return
							resize.current = undefined
							event.currentTarget.releasePointerCapture(event.pointerId)
							commitResize(active.divider, active.ratio)
						}}
						onLostPointerCapture={() => {
							if (!resize.current) return
							clearRatio(resize.current.divider.split.id)
							resize.current = undefined
						}}
						onKeyDown={(event) => {
							if (busy || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
								return
							const horizontal = divider.split.direction === 'horizontal'
							const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp'
							const increase = horizontal ? 'ArrowRight' : 'ArrowDown'
							let ratio = divider.ratio
							if (event.key === decrease) ratio -= event.shiftKey ? 0.1 : 0.02
							else if (event.key === increase) ratio += event.shiftKey ? 0.1 : 0.02
							else if (event.key === 'Home') ratio = divider.minimumRatio
							else if (event.key === 'End') ratio = divider.maximumRatio
							else return
							event.preventDefault()
							event.stopPropagation()
							commitResize(
								divider,
								Math.max(divider.minimumRatio, Math.min(divider.maximumRatio, ratio)),
							)
						}}
					/>
				))}
				{drop &&
					(() => {
						const target = geometry.groups.find(({ group }) => group.id === drop.groupId)
						if (!target) return null
						return (
							<div
								className="workspace-canvas-drop-preview"
								data-position={drop.position}
								style={boxStyle(workspaceDropRect(target.rect, drop.position))}
								aria-hidden="true"
							>
								<span>
									{drop.position === 'center' ? 'Move tab here' : `Split ${drop.position}`}
								</span>
							</div>
						)
					})()}
			</div>
		</div>
	)
}
