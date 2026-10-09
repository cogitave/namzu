import { ContextMenu } from '@base-ui/react/context-menu'
import { Menu } from '@base-ui/react/menu'
import { Tabs } from '@base-ui/react/tabs'
import { MessageCircle, SplitSquareVertical } from 'lucide-react'
import { Fragment, type ReactElement, useEffect, useRef } from 'react'
import {
	type BackgroundWorkStatus,
	freshBackgroundWorkStatus,
} from '../shared/background-work-protocol.js'
import type { ConversationView } from '../shared/protocol.js'
import type { TerminalTabView } from '../shared/terminal-tabs.js'
import type { WorkspaceWindowBounds } from '../shared/workspace-layout.js'
import {
	ComputerWorkspaceComputerTab,
	ComputerWorkspaceControls,
	ComputerWorkspaceMenuItems,
	ComputerWorkspaceProfileToggle,
	type ComputerWorkspaceToolbarProps,
	computerWorkspaceIds,
} from './computer-workspace-toolbar.js'
import { ConversationActionsMenu } from './conversation-actions-menu.js'
import type { ConversationActionId, ConversationActionInput } from './conversation-actions.js'
import { HarnessMark } from './harness-picker.js'
import {
	AppWindowIcon,
	type IconComponent,
	LoaderCircleIcon,
	MoreHorizontalIcon,
	PinIcon,
	PlusIcon,
	SplitDownIcon,
	SplitRightIcon,
	TerminalIcon,
	XIcon,
} from './icons.js'
import { type NewTabActionId, type NewTabIconId, newTabMenuGroups } from './new-tab-menu.js'
import { TerminalStripTab } from './terminal-tab.js'
import { Button } from './ui/button.js'
import { WordmarkInitial } from './wordmark.js'
import {
	WORKSPACE_TAB_DRAG_MIME,
	createWorkspaceTabDrag,
	workspaceDragEndsOutsideWindow,
} from './workspace-canvas-geometry.js'
import './computer-workspace-toolbar.css'
import './conversation-tabs.css'

/** Terminal tabs that share the strip with the conversations. */
export interface ConversationTabTerminals {
	tabs: readonly TerminalTabView[]
	/** Every tab of the pane in strip order, terminals included. */
	order: readonly string[]
	/** The terminal in front, if one is. */
	activeId?: string
	onSelect: (tab: TerminalTabView) => void
	onClose: (tab: TerminalTabView) => void
	onDetach: (tab: TerminalTabView, bounds?: WorkspaceWindowBounds) => void
	onSplit?: (tab: TerminalTabView, position: 'right' | 'bottom') => void
	/** Absent where terminals cannot be opened. */
	onNew?: () => void
}

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

const NEW_TAB_ICONS: Record<NewTabIconId, IconComponent> = {
	plus: PlusIcon,
	terminal: TerminalIcon,
	right: SplitRightIcon,
	below: SplitDownIcon,
	window: AppWindowIcon,
}

/** The right-click menu of the + button: what a new tab is, and where it opens. */
export interface ConversationTabsNewMenu {
	onAction: (id: NewTabActionId) => void
	terminalReason?: string
	conversationReason?: string
	windowReason?: string
}

function NewTabContextMenu({
	menu,
	busy,
	children,
}: {
	menu: ConversationTabsNewMenu
	busy: boolean
	children: ReactElement
}) {
	const groups = newTabMenuGroups(menu)
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger render={children} />
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="conversation-actions-positioner" sideOffset={2}>
					<ContextMenu.Popup className="conversation-actions-popup" aria-label="New tab">
						{groups.map((group, index) => (
							<Fragment key={group[0]?.id}>
								{index > 0 && <Menu.Separator className="conversation-actions-separator" />}
								{group.map((entry) => {
									const Icon = NEW_TAB_ICONS[entry.icon]
									return (
										<Menu.Item
											key={entry.id}
											className="conversation-actions-item"
											disabled={busy || !!entry.reason}
											title={entry.reason}
											aria-description={entry.reason}
											onClick={() => menu.onAction(entry.id)}
										>
											<Icon aria-hidden="true" />
											<span className="conversation-actions-label">{entry.label}</span>
										</Menu.Item>
									)
								})}
							</Fragment>
						))}
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	)
}

/** What the shared conversation menu needs from the application, per tab. */
export interface ConversationTabActions {
	mac: boolean
	input: (view: ConversationView) => ConversationActionInput
	run: (id: ConversationActionId, view: ConversationView, trigger: HTMLElement | null) => void
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
	actions?: ConversationTabActions
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
	actions,
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
	// Without an application binding the menu offers only what the tab's own callbacks can do.
	const input: ConversationActionInput = actions?.input(view) ?? {
		view,
		isPal,
		running,
		queued: 0,
		permissions: 0,
		backgroundRunning: 0,
		hasMessages: false,
		hasReply: false,
		hasProjectPath: false,
		canMoveRight: !!onSplit,
		can: {
			rename: false,
			pin: false,
			fork: false,
			markdown: false,
			copy: false,
			archive: !!onRemove,
			moveRight: !!onSplit,
			moveWindow: true,
		},
	}
	const run = (id: ConversationActionId, opener: HTMLElement | null) => {
		if (busy) return
		if (actions) return actions.run(id, view, opener)
		if (id === 'move-right') onSplit?.(view, 'right')
		else if (id === 'move-window') onDetach(view)
		else if (id === 'archive') onRemove?.(view, opener)
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
						: `${view.harness === 'codex-cli' ? 'Codex CLI' : view.harness === 'claude-code' ? 'Claude Code' : 'Namzu'}: ${label}${view.pinned ? ', pinned' : ''}`
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
				{view.pinned && (
					<PinIcon className="conversation-row-pin conversation-tab-pin" aria-hidden="true" />
				)}
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
				<ConversationActionsMenu
					input={input}
					mac={actions?.mac ?? false}
					busy={busy}
					label={`${label} tab actions`}
					acceptedRef={accepted}
					trigger={
						<Button
							variant="ghost-muted"
							size="icon-xs"
							className="conversation-tab-more"
							aria-label={`Actions for ${label}`}
							disabled={busy}
						>
							<MoreHorizontalIcon />
						</Button>
					}
					leading={
						pal && (
							<ComputerWorkspaceMenuItems
								{...pal}
								busy={busy || pal.busy}
								onAccepted={() => {
									accepted.current = true
								}}
							/>
						)
					}
					afterMove={
						onSplit && (
							<Menu.Item
								className="conversation-actions-item"
								disabled={busy}
								onClick={() => act(() => onSplit(view, 'bottom'))}
							>
								<SplitSquareVertical aria-hidden="true" />
								<span className="conversation-actions-label">Split down</span>
							</Menu.Item>
						)
					}
					onAction={run}
				/>
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
	actions,
	palNames,
	palWorkspace,
	terminals,
	newMenu,
}: {
	newMenu?: ConversationTabsNewMenu
	terminals?: ConversationTabTerminals
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
	actions?: ConversationTabActions
	palNames?: Readonly<Record<string, string>>
	palWorkspace?: ConversationPalWorkspace
}) {
	const currentPal = palWorkspace?.conversationId === active ? palWorkspace : undefined
	const computerValue = currentPal ? computerWorkspaceIds(currentPal.idPrefix).computerTab : ''
	const selected = terminals?.activeId
		? terminals.activeId
		: currentPal?.computerTabOpen && currentPal.activeTab === 'computer'
			? computerValue
			: active
	// The strip's order is the pane's: a terminal sits between conversations where the person put it.
	const terminalById = new Map(terminals?.tabs.map((tab) => [tab.id, tab]))
	const conversationById = new Map(tabs.map((view) => [view.id, view]))
	type StripItem =
		| { kind: 'conversation'; view: ConversationView }
		| { kind: 'terminal'; tab: TerminalTabView }
	const strip: StripItem[] = []
	if (terminals) {
		for (const id of terminals.order) {
			const tab = terminalById.get(id)
			const view = conversationById.get(id)
			if (tab) strip.push({ kind: 'terminal', tab })
			else if (view) strip.push({ kind: 'conversation', view })
		}
	} else for (const view of tabs) strip.push({ kind: 'conversation', view })
	return (
		<Tabs.Root
			className="conversation-tabs"
			value={selected}
			onValueChange={(id) => {
				if (busy) return
				const terminal = terminalById.get(id)
				if (terminal) {
					terminals?.onSelect(terminal)
					return
				}
				const selection = resolveConversationTabSelection(tabs, active, id, currentPal)
				if (selection?.kind === 'computer') currentPal?.onOpenComputer?.()
				else if (selection?.kind === 'chat') currentPal?.onOpenChat?.()
				else if (selection?.kind === 'conversation') onSelect(selection.view)
			}}
		>
			<Tabs.List className="conversation-tab-list" aria-label="Conversation tabs">
				{strip.map((item) =>
					item.kind === 'terminal' ? (
						<TerminalStripTab
							key={item.tab.id}
							tab={item.tab}
							windowId={windowId}
							groupId={groupId}
							active={selected === item.tab.id}
							busy={busy}
							onClose={(tab) => terminals?.onClose(tab)}
							onDetach={(tab, bounds) => terminals?.onDetach(tab, bounds)}
							onSplit={terminals?.onSplit}
						/>
					) : (
						<Fragment key={item.view.id}>
							<ConversationTab
								view={item.view}
								windowId={windowId}
								groupId={groupId}
								active={selected === item.view.id}
								busy={busy}
								running={running(item.view.id)}
								backgroundWork={backgroundWork?.[item.view.id]}
								palName={item.view.palId ? palNames?.[item.view.palId] : undefined}
								pal={item.view.id === currentPal?.conversationId ? currentPal : undefined}
								onClose={onClose}
								onRemove={onRemove}
								onDetach={onDetach}
								onSplit={onSplit}
								actions={actions}
							/>
							{item.view.id === currentPal?.conversationId && currentPal.computerTabOpen && (
								<ComputerWorkspaceComputerTab
									{...currentPal}
									value={computerValue}
									shared
									disabled={busy}
								/>
							)}
						</Fragment>
					),
				)}
			</Tabs.List>
			{(() => {
				const withMenu = (button: ReactElement) =>
					newMenu ? (
						<NewTabContextMenu menu={newMenu} busy={busy}>
							{button}
						</NewTabContextMenu>
					) : (
						button
					)
				return (
					<>
						{withMenu(
							<Button
								variant="ghost-muted"
								size="icon-sm"
								aria-label="New conversation tab"
								disabled={busy}
								onClick={onNew}
							>
								<PlusIcon />
							</Button>,
						)}
						{terminals?.onNew &&
							withMenu(
								<Button
									variant="ghost-muted"
									size="icon-sm"
									aria-label="New terminal tab"
									title="New terminal (Ctrl+Shift+`)"
									disabled={busy}
									onClick={terminals.onNew}
								>
									<TerminalIcon />
								</Button>,
							)}
					</>
				)
			})()}
			{currentPal && <ComputerWorkspaceControls {...currentPal} disabled={busy} />}
		</Tabs.Root>
	)
}
