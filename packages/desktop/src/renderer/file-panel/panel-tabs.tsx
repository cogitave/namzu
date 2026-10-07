import { Menu } from '@base-ui/react/menu'
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
} from 'react'
import '../conversation-actions-menu.css'
import {
	FileDiffIcon,
	Maximize2Icon,
	Minimize2Icon,
	PanelRightIcon,
	PlusIcon,
	TerminalIcon,
	XIcon,
} from '../icons.js'
import { Button } from '../ui/button.js'
import { FileTypeIcon } from './file-icons.js'
import { type PanelTab, activityTab, changesTab, sameTab, tabKey } from './file-tabs.js'
import { baseNameOf } from './project-refs.js'

/** What the panel body shows: a tab's content, the quick open, or nothing once every tab is closed. */
export type PanelView = 'changes' | 'activity' | 'file' | 'browse' | 'empty'

export function tabLabel(tab: PanelTab): string {
	return tab.kind === 'changes'
		? 'Changes'
		: tab.kind === 'activity'
			? 'Activity'
			: baseNameOf(tab.path)
}

/** Delete or Ctrl+W (Cmd+W) on a focused tab closes it. */
export function closesTab(event: {
	key: string
	ctrlKey: boolean
	metaKey: boolean
	altKey: boolean
	shiftKey: boolean
}): boolean {
	if (event.altKey || event.shiftKey) return false
	if (event.key === 'Delete') return !event.ctrlKey && !event.metaKey
	return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w'
}

/** Which edges of the tab scroller have more tabs out of sight; a pixel of slack absorbs sub-pixel scroll positions. */
export function overflowEdges(box: {
	scrollLeft: number
	clientWidth: number
	scrollWidth: number
}): {
	start: boolean
	end: boolean
} {
	return {
		start: box.scrollLeft > 1,
		end: box.scrollLeft + box.clientWidth < box.scrollWidth - 1,
	}
}

/** Writes the edges onto the element, touching the DOM only when one changed. */
function syncOverflow(element: HTMLElement) {
	const { start, end } = overflowEdges(element)
	if ((element.dataset.overflowStart !== undefined) !== start) {
		if (start) element.dataset.overflowStart = ''
		else delete element.dataset.overflowStart
	}
	if ((element.dataset.overflowEnd !== undefined) !== end) {
		if (end) element.dataset.overflowEnd = ''
		else delete element.dataset.overflowEnd
	}
}

function TabIcon({ tab }: { tab: PanelTab }) {
	if (tab.kind === 'changes') return <FileDiffIcon aria-hidden="true" />
	if (tab.kind === 'activity') return <TerminalIcon aria-hidden="true" />
	return <FileTypeIcon path={tab.path} />
}

/** Changes, Activity and open files are one list of tabs; "+" adds one, the buttons at the right size the panel. */
export function PanelTabStrip({
	tabs,
	active,
	browsing,
	canBrowse,
	running,
	attention,
	expanded,
	onActivate,
	onClose,
	onOpenTab,
	onBrowse,
	onToggleExpanded,
	onHide,
	panelId,
}: {
	/** The element id of the body this strip switches, for aria-controls. */
	panelId?: string
	tabs: readonly PanelTab[]
	active?: PanelTab
	/** The quick open is showing, so no tab is selected. */
	browsing: boolean
	canBrowse: boolean
	/** Background work running now; shown on the Activity tab. */
	running: number
	/** Background work that needs a decision; the count turns to the warning colour. */
	attention: boolean
	expanded: boolean
	onActivate: (tab: PanelTab) => void
	onClose: (tab: PanelTab) => void
	/** Adds Changes or Activity if it was closed, and shows it. */
	onOpenTab: (tab: PanelTab) => void
	onBrowse: () => void
	onToggleExpanded: () => void
	onHide: () => void
}) {
	const strip = useRef<HTMLDivElement>(null)
	const scroller = useRef<HTMLDivElement>(null)
	const refocus = useRef(false)
	const shown = browsing ? undefined : active
	const order = tabs.map(tabKey).join('\n')
	// A tab opened or chosen out of sight must come into view, or nothing says it opened.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these changes are what bring a tab into view.
	useLayoutEffect(() => {
		const tab = strip.current?.querySelector<HTMLElement>('.panel-tab[data-active]')
		tab?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
		// After a keyboard close the focus would otherwise fall to the page.
		if (refocus.current) {
			refocus.current = false
			const target =
				strip.current?.querySelector<HTMLElement>('[role="tab"][data-active]') ??
				strip.current?.querySelector<HTMLElement>('[role="tab"]') ??
				// Every tab is gone; the "+" is the way back in.
				strip.current?.querySelector<HTMLElement>('.panel-tab-add')
			target?.focus()
		}
		if (scroller.current) syncOverflow(scroller.current)
	}, [shown && tabKey(shown), order])
	// The fade shows only on an edge with tabs behind it; scrolling and resizing move that.
	useEffect(() => {
		const element = scroller.current
		if (!element) return
		const sync = () => syncOverflow(element)
		element.addEventListener('scroll', sync, { passive: true })
		const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(sync)
		observer?.observe(element)
		sync()
		return () => {
			element.removeEventListener('scroll', sync)
			observer?.disconnect()
		}
	}, [])
	const keys = (event: KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement
		if (target.getAttribute('role') !== 'tab') return
		// One tab stop for the whole strip; the arrow keys move between tabs, as in a tab list.
		if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			const list = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
			const at = list.indexOf(target)
			if (at < 0) return
			event.preventDefault()
			const next =
				event.key === 'Home'
					? 0
					: event.key === 'End'
						? list.length - 1
						: (at + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length
			list[next]?.focus()
			list[next]?.click()
			return
		}
		if (!closesTab(event)) return
		const tab = tabs.find((item) => tabKey(item) === target.dataset.tab)
		if (!tab) return
		event.preventDefault()
		refocus.current = true
		onClose(tab)
	}
	// With nothing selected, the first tab is the way in.
	const stop = (tab: PanelTab, index: number) =>
		sameTab(tab, shown) || (!shown && index === 0) ? 0 : -1
	const addable: PanelTab[] = [
		...(tabs.some((tab) => tab.kind === 'changes') ? [] : [changesTab]),
		...(tabs.some((tab) => tab.kind === 'activity') ? [] : [activityTab]),
	]
	return (
		<div ref={strip} className="panel-tab-strip">
			{/* biome-ignore lint/a11y/useSemanticElements: a tab list has no native element. */}
			<div className="panel-tab-list" role="tablist" aria-label="Side panel" onKeyDown={keys}>
				<div ref={scroller} className="panel-tab-scroll">
					{tabs.map((tab, index) => {
						const selected = sameTab(tab, shown)
						const name = tabLabel(tab)
						const badge = tab.kind === 'activity' && running > 0
						return (
							// The tab is the name button; the close button sits beside it, never inside a tab.
							<div
								key={tabKey(tab)}
								className="panel-tab"
								role="presentation"
								data-kind={tab.kind}
								data-active={selected || undefined}
								title={tab.kind === 'file' ? tab.path : undefined}
								// A middle click closes, as in a browser; mousedown would otherwise start autoscroll.
								onMouseDown={(event) => event.button === 1 && event.preventDefault()}
								onAuxClick={(event) => {
									if (event.button !== 1) return
									event.preventDefault()
									onClose(tab)
								}}
							>
								<button
									type="button"
									role="tab"
									aria-selected={selected}
									aria-controls={panelId}
									aria-label={
										badge
											? `${name}, ${running} running${attention ? ', needs attention' : ''}`
											: undefined
									}
									tabIndex={stop(tab, index)}
									data-active={selected || undefined}
									data-tab={tabKey(tab)}
									className="panel-tab-name"
									onClick={() => onActivate(tab)}
								>
									<TabIcon tab={tab} />
									<span>{name}</span>
									{badge && (
										<span
											className="panel-tab-badge"
											data-attention={attention || undefined}
											aria-hidden="true"
										>
											{running > 99 ? '99+' : running}
										</span>
									)}
								</button>
								<button
									type="button"
									className="panel-tab-close"
									aria-label={`Close ${name}`}
									tabIndex={-1}
									onClick={() => onClose(tab)}
								>
									<XIcon aria-hidden="true" />
								</button>
							</div>
						)
					})}
				</div>
			</div>
			{(addable.length > 0 || canBrowse) && (
				<Menu.Root>
					<Menu.Trigger
						render={<Button size="icon-xs" variant="ghost-muted" className="panel-tab-add" />}
						aria-label="Add a tab"
						title="Add a tab"
						data-active={browsing || undefined}
					>
						<PlusIcon aria-hidden="true" />
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner
							className="conversation-actions-positioner"
							align="start"
							sideOffset={6}
						>
							<Menu.Popup
								className="conversation-actions-popup panel-add-popup"
								aria-label="Add a tab"
							>
								{addable.map((tab) => (
									<Menu.Item
										key={tab.kind}
										className="conversation-actions-item"
										onClick={() => onOpenTab(tab)}
									>
										<TabIcon tab={tab} />
										<span className="conversation-actions-label">{tabLabel(tab)}</span>
									</Menu.Item>
								))}
								{addable.length > 0 && canBrowse && (
									<Menu.Separator className="conversation-actions-separator" />
								)}
								{canBrowse && (
									<Menu.Item className="conversation-actions-item" onClick={onBrowse}>
										<FileTypeIcon path="" />
										<span className="conversation-actions-label">Open file…</span>
									</Menu.Item>
								)}
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			)}
			<div className="panel-strip-actions">
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label={expanded ? 'Restore panel' : 'Expand panel'}
					title={expanded ? 'Restore panel' : 'Expand panel'}
					aria-pressed={expanded}
					onClick={onToggleExpanded}
				>
					{expanded ? <Minimize2Icon aria-hidden="true" /> : <Maximize2Icon aria-hidden="true" />}
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label="Hide panel"
					title="Hide panel"
					onClick={onHide}
				>
					<PanelRightIcon aria-hidden="true" />
				</Button>
			</div>
		</div>
	)
}

/** A thin edge on the panel's left that resizes it; arrow keys do the same for the keyboard. */
export function PanelResizeHandle({
	width,
	onResize,
	onCommit,
	onDragging,
	now,
	min,
	max,
}: {
	/** The width last measured, and the bounds it moves within, for assistive technology. */
	now: number
	min: number
	max: () => number
	width: () => number
	onResize: (width: number) => void
	onCommit: (width: number) => void
	/** True while the edge is held, so the page can skip its width transition. */
	onDragging?: (dragging: boolean) => void
}) {
	const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null)
	const move = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current
		if (!state) return
		// The panel sits on the right, so dragging left makes it wider.
		state.last = state.startWidth + (state.startX - event.clientX)
		onResize(state.last)
	}
	const end = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current
		if (!state) return
		drag.current = null
		onDragging?.(false)
		event.currentTarget.releasePointerCapture?.(event.pointerId)
		onCommit(state.last)
	}
	return (
		// biome-ignore lint/a11y/useSemanticElements: an hr cannot take focus and keys as a separator can.
		<div
			className="panel-resize-handle"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize side panel"
			aria-valuenow={Math.round(now)}
			aria-valuemin={min}
			aria-valuemax={Math.max(min, Math.round(max()))}
			tabIndex={0}
			onPointerDown={(event) => {
				if (event.button !== 0) return
				event.preventDefault()
				event.currentTarget.setPointerCapture?.(event.pointerId)
				const startWidth = width()
				drag.current = { startX: event.clientX, startWidth, last: startWidth }
				onDragging?.(true)
			}}
			onPointerMove={move}
			onPointerUp={end}
			onPointerCancel={end}
			onKeyDown={(event) => {
				const step = event.shiftKey ? 80 : 24
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
				event.preventDefault()
				const next = width() + (event.key === 'ArrowLeft' ? step : -step)
				onResize(next)
				onCommit(next)
			}}
		/>
	)
}
