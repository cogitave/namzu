import { Menu } from '@base-ui/react/menu'
import { Tabs } from '@base-ui/react/tabs'
import { SplitSquareVertical } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { TerminalTabView } from '../shared/terminal-tabs.js'
import type { WorkspaceWindowBounds } from '../shared/workspace-layout.js'
import { AppWindowIcon, MoreHorizontalIcon, SplitRightIcon, XIcon } from './icons.js'
import { TAB_TITLE_CHARS, shortenTitle } from './short-title.js'
import {
	TerminalBadge,
	TerminalMark,
	terminalBadgeLabel,
	terminalStatusText,
} from './terminal-pane.js'
import { Button } from './ui/button.js'
import {
	WORKSPACE_TAB_DRAG_MIME,
	createWorkspaceTabDrag,
	workspaceDragEndsOutsideWindow,
} from './workspace-canvas-geometry.js'

/** A terminal's tab in the pane's strip: dragged, split and closed like a conversation's. */
export function TerminalStripTab({
	tab,
	windowId,
	groupId,
	active,
	busy,
	onClose,
	onDetach,
	onSplit,
	onNew,
	newReason,
}: {
	tab: TerminalTabView
	windowId: string
	groupId: string
	active: boolean
	busy: boolean
	onClose: (tab: TerminalTabView) => void
	onDetach: (tab: TerminalTabView, bounds?: WorkspaceWindowBounds) => void
	onSplit?: (tab: TerminalTabView, position: 'right' | 'bottom') => void
	/** Opens another terminal beside or below this pane; absent where the strip has no such menu. */
	onNew?: (id: 'terminal-right' | 'terminal-below') => void
	/** Why a new terminal cannot open here. */
	newReason?: string
}) {
	const drag = useRef({ cancelled: false, allowed: true })
	const stopEscape = useRef<(() => void) | undefined>(undefined)
	useEffect(() => () => stopEscape.current?.(), [])
	const badge = terminalBadgeLabel(tab)
	const ended = tab.status !== 'running'
	const statusTitle = terminalStatusText(tab)
	return (
		<div
			className="conversation-tab terminal-strip-tab"
			data-active={active}
			data-terminal-tab-id={tab.id}
			data-tab-id={tab.id}
			data-kind={tab.kind}
			draggable={!busy}
			onPointerDownCapture={(event) => {
				if (
					event.button === 1 &&
					event.target instanceof Element &&
					event.target.closest('.conversation-tab-label')
				) {
					drag.current.allowed = false
					event.preventDefault()
					event.stopPropagation()
					return
				}
				drag.current.allowed = !(
					event.target instanceof Element && event.target.closest('.conversation-tab-actions')
				)
			}}
			onDragStart={(event) => {
				if (busy || !drag.current.allowed) {
					event.preventDefault()
					return
				}
				stopEscape.current?.()
				drag.current.cancelled = false
				event.dataTransfer.setData(
					WORKSPACE_TAB_DRAG_MIME,
					createWorkspaceTabDrag({ windowId, groupId, tabId: tab.id }),
				)
				event.dataTransfer.effectAllowed = 'move'
				const cancel = (key: KeyboardEvent) => {
					if (key.key === 'Escape') drag.current.cancelled = true
				}
				window.addEventListener('keydown', cancel, true)
				stopEscape.current = () => window.removeEventListener('keydown', cancel, true)
			}}
			onDragEnd={(event) => {
				stopEscape.current?.()
				stopEscape.current = undefined
				if (
					busy ||
					!workspaceDragEndsOutsideWindow({
						x: event.screenX,
						y: event.screenY,
						dropEffect: event.dataTransfer.dropEffect,
						cancelled: drag.current.cancelled,
						window: {
							x: window.screenX,
							y: window.screenY,
							width: window.outerWidth,
							height: window.outerHeight,
						},
					})
				)
					return
				onDetach(tab, {
					x: Math.round(event.screenX - 80),
					y: Math.round(event.screenY - 20),
					width: Math.max(700, Math.round(window.outerWidth)),
					height: Math.max(600, Math.round(window.outerHeight)),
				})
			}}
		>
			<Tabs.Tab
				value={tab.id}
				disabled={busy}
				onAuxClick={(event) => {
					if (event.button !== 1 || busy) return
					event.preventDefault()
					event.stopPropagation()
					onClose(tab)
				}}
				render={<Button variant="ghost" size="sm" />}
				className="conversation-tab-label"
				aria-label={`${tab.title}, terminal${badge ? `, ${badge}` : ended ? ', ended' : ''}`}
			>
				<span className="conversation-tab-mark" aria-hidden="true">
					<TerminalMark tab={tab} />
				</span>
				<span className="truncate" title={statusTitle}>
					{shortenTitle(tab.title, TAB_TITLE_CHARS)}
				</span>
				<TerminalBadge tab={tab} />
			</Tabs.Tab>
			<div className="conversation-tab-actions">
				<Menu.Root>
					<Menu.Trigger
						render={
							<Button
								variant="ghost-muted"
								size="icon-xs"
								className="conversation-tab-more"
								aria-label={`Actions for ${tab.title}`}
								disabled={busy}
							/>
						}
					>
						<MoreHorizontalIcon />
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
							<Menu.Popup
								className="conversation-actions-popup"
								aria-label={`${tab.title} tab actions`}
							>
								{onNew && (
									<>
										<Menu.Item
											className="conversation-actions-item"
											disabled={busy || !!newReason}
											title={newReason}
											onClick={() => onNew('terminal-right')}
										>
											<SplitRightIcon aria-hidden="true" />
											<span className="conversation-actions-label">New terminal to the right</span>
										</Menu.Item>
										<Menu.Item
											className="conversation-actions-item"
											disabled={busy || !!newReason}
											title={newReason}
											onClick={() => onNew('terminal-below')}
										>
											<SplitSquareVertical aria-hidden="true" />
											<span className="conversation-actions-label">New terminal below</span>
										</Menu.Item>
										<Menu.Separator className="conversation-actions-separator" />
									</>
								)}
								{onSplit && (
									<Menu.Item
										className="conversation-actions-item"
										disabled={busy}
										onClick={() => onSplit(tab, 'right')}
									>
										<SplitRightIcon aria-hidden="true" />
										<span className="conversation-actions-label">Move to right pane</span>
									</Menu.Item>
								)}
								{onSplit && (
									<Menu.Item
										className="conversation-actions-item"
										disabled={busy}
										onClick={() => onSplit(tab, 'bottom')}
									>
										<SplitSquareVertical aria-hidden="true" />
										<span className="conversation-actions-label">Split down</span>
									</Menu.Item>
								)}
								<Menu.Item
									className="conversation-actions-item"
									disabled={busy}
									onClick={() => onDetach(tab)}
								>
									<AppWindowIcon aria-hidden="true" />
									<span className="conversation-actions-label">Move to new window</span>
								</Menu.Item>
								<Menu.Separator className="conversation-actions-separator" />
								<Menu.Item
									className="conversation-actions-item"
									data-destructive
									disabled={busy}
									onClick={() => onClose(tab)}
								>
									<XIcon aria-hidden="true" />
									<span className="conversation-actions-label">
										{ended ? 'Close tab' : 'End session and close tab'}
									</span>
								</Menu.Item>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
				<Button
					variant="ghost-muted"
					size="icon-xs"
					disabled={busy}
					aria-label={`Close tab ${tab.title}`}
					onClick={() => onClose(tab)}
				>
					<XIcon />
				</Button>
			</div>
		</div>
	)
}
