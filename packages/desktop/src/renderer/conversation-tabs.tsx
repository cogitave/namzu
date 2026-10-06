import { Menu } from '@base-ui/react/menu'
import { Tabs } from '@base-ui/react/tabs'
import {
	MessageCircle,
	PanelsTopLeft,
	SplitSquareHorizontal,
	SplitSquareVertical,
} from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import {
	type BackgroundWorkStatus,
	freshBackgroundWorkStatus,
} from '../shared/background-work-protocol.js'
import type { ConversationView } from '../shared/protocol.js'
import type { WorkspaceWindowBounds } from '../shared/workspace-layout.js'
import {
	ComputerWorkspaceComputerTab,
	ComputerWorkspaceControls,
	ComputerWorkspaceMenuItems,
	ComputerWorkspaceProfileToggle,
	type ComputerWorkspaceToolbarProps,
	computerWorkspaceIds,
} from './computer-workspace-toolbar.js'
import { HarnessMark } from './harness-picker.js'
import {
	LoaderCircleIcon,
	MoreHorizontalIcon,
	PlusIcon,
	TerminalIcon,
	TrashIcon,
	XIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import { WordmarkInitial } from './wordmark.js'
import {
	WORKSPACE_TAB_DRAG_MIME,
	createWorkspaceTabDrag,
	workspaceDragEndsOutsideWindow,
} from './workspace-canvas-geometry.js'
import './computer-workspace-toolbar.css'
import './conversation-tabs.css'

export interface ConversationPalWorkspace extends ComputerWorkspaceToolbarProps {
	conversationId: string
}

/** Computer/chat switches retain the current session; other tabs change its owner. */
export function resolveConversationTabSelection(
	tabs: readonly ConversationView[],
	active: string,
	value: string,
	pal?: ConversationPalWorkspace,
): { kind: 'computer' | 'chat' } | { kind: 'conversation'; view: ConversationView } | null {
	if (
		pal &&
		active === pal.conversationId &&
		pal.computerTabOpen &&
		value === computerWorkspaceIds(pal.idPrefix).computerTab
	)
		return { kind: 'computer' }
	const view = tabs.find((tab) => tab.id === value)
	if (!view) return null
	if (pal && active === pal.conversationId && view.id === pal.conversationId)
		return { kind: 'chat' }
	return { kind: 'conversation', view }
}

interface ConversationTabProps {
	view: ConversationView
	windowId: string
	groupId: string
	active: boolean
	busy: boolean
	running: boolean
	backgroundWork?: BackgroundWorkStatus
	palName?: string
	pal?: ConversationPalWorkspace
	onClose: (view: ConversationView) => void
	onRemove?: (view: ConversationView, trigger: HTMLElement | null) => void
	onDetach: (view: ConversationView, bounds?: WorkspaceWindowBounds) => void
	onSplit?: (view: ConversationView, position: 'right' | 'bottom') => void
}

function ConversationTab({
	view,
	windowId,
	groupId,
	active,
	busy,
	running,
	backgroundWork,
	palName,
	pal,
	onClose,
	onRemove,
	onDetach,
	onSplit,
}: ConversationTabProps) {
	const label = palName ?? pal?.palName ?? view.title
	const isPal = !!view.palId || !!pal
	const work =
		isPal || (view.harness && view.harness !== 'namzu')
			? { state: 'unavailable' as const }
			: freshBackgroundWorkStatus(backgroundWork)
	const workLabel =
		work.state === 'known' && (work.runningCount > 0 || work.needsAttention)
			? work.runningCount > 0
				? `${work.runningCount} ${work.runningCount === 1 ? 'process' : 'processes'} running in background${work.needsAttention ? '; background work needs attention' : ''}`
				: 'Background work needs attention'
			: undefined
	const ids = pal ? computerWorkspaceIds(pal.idPrefix) : undefined
	const trigger = useRef<HTMLButtonElement>(null)
	const accepted = useRef(false)
	const drag = useRef<{ cancelled: boolean; allowed: boolean }>({
		cancelled: false,
		allowed: true,
	})
	const stopEscape = useRef<(() => void) | undefined>(undefined)
	useEffect(() => () => stopEscape.current?.(), [])
	const act = (action: () => void) => {
		if (busy) return
		accepted.current = true
		action()
	}
	return (
		<div
			className="conversation-tab"
			data-active={active}
			data-pal={isPal}
			data-tab-id={view.id}
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
					createWorkspaceTabDrag({ windowId, groupId, tabId: view.id }),
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
				onDetach(view, {
					x: Math.round(event.screenX - 80),
					y: Math.round(event.screenY - 20),
					width: Math.max(700, Math.round(window.outerWidth)),
					height: Math.max(600, Math.round(window.outerHeight)),
				})
			}}
		>
			<Tabs.Tab
				id={ids?.chatTab}
				data-pal-chat-tab={pal ? '' : undefined}
				aria-controls={ids?.chatPanel}
				value={view.id}
				disabled={busy}
				aria-description={workLabel}
				onAuxClick={(event) => {
					if (event.button !== 1 || busy) return
					event.preventDefault()
					event.stopPropagation()
					onClose(view)
				}}
				render={<Button variant="ghost" size="sm" />}
				className="conversation-tab-label"
				aria-label={
					isPal
						? label
						: `${view.harness === 'codex-cli' ? 'Codex CLI' : view.harness === 'claude-code' ? 'Claude Code' : 'Namzu'}: ${label}`
				}
			>
				<span className="conversation-tab-mark" aria-hidden="true">
					{running ? (
						<LoaderCircleIcon className="size-3 animate-spin" />
					) : isPal ? (
						<MessageCircle />
					) : !view.harness || view.harness === 'namzu' ? (
						<WordmarkInitial />
					) : (
						<HarnessMark engine={view.harness} />
					)}
				</span>
				<span className="truncate" title={label}>
					{label}
				</span>
				{workLabel && work.state === 'known' && (
					<span
						className="conversation-tab-background-work"
						data-background-work={work.needsAttention ? 'attention' : 'running'}
						aria-hidden="true"
					>
						{work.needsAttention ? '!' : <TerminalIcon />}
						{work.runningCount > 0 && <span>{work.runningCount}</span>}
					</span>
				)}
			</Tabs.Tab>
			<div className="conversation-tab-actions">
				<Menu.Root
					onOpenChange={(open) => {
						if (open) accepted.current = false
					}}
				>
					<Menu.Trigger
						render={
							<Button
								ref={trigger}
								variant="ghost-muted"
								size="icon-xs"
								className="conversation-tab-more"
								aria-label={`Actions for ${label}`}
								disabled={busy}
							/>
						}
					>
						<MoreHorizontalIcon />
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner
							className="computer-workspace-menu-positioner"
							align="end"
							sideOffset={6}
						>
							<Menu.Popup
								className="computer-workspace-menu"
								aria-label={`${label} tab actions`}
								finalFocus={() => (accepted.current ? false : (trigger.current ?? true))}
							>
								{pal && (
									<>
										<ComputerWorkspaceMenuItems
											{...pal}
											busy={busy || pal.busy}
											onAccepted={() => {
												accepted.current = true
											}}
										/>
										<Menu.Separator className="computer-workspace-menu-separator" />
									</>
								)}
								{onSplit && (
									<>
										<Menu.Item
											className="computer-workspace-menu-item"
											disabled={busy}
											onClick={() => act(() => onSplit(view, 'right'))}
										>
											<SplitSquareHorizontal aria-hidden="true" />
											Split right
										</Menu.Item>
										<Menu.Item
											className="computer-workspace-menu-item"
											disabled={busy}
											onClick={() => act(() => onSplit(view, 'bottom'))}
										>
											<SplitSquareVertical aria-hidden="true" />
											Split down
										</Menu.Item>
										<Menu.Separator className="computer-workspace-menu-separator" />
									</>
								)}
								<Menu.Item
									className="computer-workspace-menu-item"
									disabled={busy}
									onClick={() => act(() => onDetach(view))}
								>
									<PanelsTopLeft aria-hidden="true" />
									Move to new window
								</Menu.Item>
								{!isPal && onRemove && (
									<>
										<Menu.Separator className="computer-workspace-menu-separator" />
										<Menu.Item
											className="computer-workspace-menu-item text-destructive-foreground"
											disabled={busy || running}
											onClick={() => act(() => onRemove(view, trigger.current))}
										>
											<TrashIcon aria-hidden="true" />
											Delete conversation
										</Menu.Item>
									</>
								)}
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
				{pal && <ComputerWorkspaceProfileToggle {...pal} />}
				<Button
					variant="ghost-muted"
					size="icon-xs"
					disabled={busy}
					aria-label={`Close tab ${label}`}
					onClick={() => onClose(view)}
				>
					<XIcon />
				</Button>
			</div>
		</div>
	)
}

/** Views are peers; closing a tab does not stop or delete its owned conversation. */
export function ConversationTabs({
	tabs,
	windowId,
	groupId,
	active,
	busy,
	running,
	backgroundWork,
	onSelect,
	onClose,
	onRemove,
	onNew,
	onDetach,
	onSplit,
	palNames,
	palWorkspace,
}: {
	tabs: readonly ConversationView[]
	windowId: string
	groupId: string
	active: string
	busy: boolean
	running: (id: string) => boolean
	backgroundWork?: Readonly<Record<string, BackgroundWorkStatus>>
	onSelect: (view: ConversationView) => void
	onClose: (view: ConversationView) => void
	onRemove?: (view: ConversationView, trigger: HTMLElement | null) => void
	onNew: () => void
	onDetach: (view: ConversationView, bounds?: WorkspaceWindowBounds) => void
	onSplit?: (view: ConversationView, position: 'right' | 'bottom') => void
	palNames?: Readonly<Record<string, string>>
	palWorkspace?: ConversationPalWorkspace
}) {
	const currentPal = palWorkspace?.conversationId === active ? palWorkspace : undefined
	const computerValue = currentPal ? computerWorkspaceIds(currentPal.idPrefix).computerTab : ''
	const selected =
		currentPal?.computerTabOpen && currentPal.activeTab === 'computer' ? computerValue : active
	return (
		<Tabs.Root
			className="conversation-tabs"
			value={selected}
			onValueChange={(id) => {
				if (busy) return
				const selection = resolveConversationTabSelection(tabs, active, id, currentPal)
				if (selection?.kind === 'computer') currentPal?.onOpenComputer?.()
				else if (selection?.kind === 'chat') currentPal?.onOpenChat?.()
				else if (selection?.kind === 'conversation') onSelect(selection.view)
			}}
		>
			<Tabs.List className="conversation-tab-list" aria-label="Conversation tabs">
				{tabs.map((view) => (
					<Fragment key={view.id}>
						<ConversationTab
							view={view}
							windowId={windowId}
							groupId={groupId}
							active={selected === view.id}
							busy={busy}
							running={running(view.id)}
							backgroundWork={backgroundWork?.[view.id]}
							palName={view.palId ? palNames?.[view.palId] : undefined}
							pal={view.id === currentPal?.conversationId ? currentPal : undefined}
							onClose={onClose}
							onRemove={onRemove}
							onDetach={onDetach}
							onSplit={onSplit}
						/>
						{view.id === currentPal?.conversationId && currentPal.computerTabOpen && (
							<ComputerWorkspaceComputerTab
								{...currentPal}
								value={computerValue}
								shared
								disabled={busy}
							/>
						)}
					</Fragment>
				))}
			</Tabs.List>
			<Button
				variant="ghost-muted"
				size="icon-sm"
				aria-label="New conversation tab"
				disabled={busy}
				onClick={onNew}
			>
				<PlusIcon />
			</Button>
			{currentPal && <ComputerWorkspaceControls {...currentPal} disabled={busy} />}
		</Tabs.Root>
	)
}
