import { Menu } from '@base-ui/react/menu'
import { Tabs } from '@base-ui/react/tabs'
import { MessageCircle, Pause, PictureInPicture2, Play, SlidersHorizontal } from 'lucide-react'
import { useRef } from 'react'
import {
	MonitorIcon,
	MoreHorizontalIcon,
	PanelRightIcon,
	PencilIcon,
	PlusIcon,
	RefreshIcon,
	TrashIcon,
	XIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import './computer-workspace-toolbar.css'

/** Each Pal pane links its tabs to its own panels; standalone callers retain their IDs. */
export function computerWorkspaceIds(prefix?: string) {
	const suffix = prefix === undefined ? '' : `-${encodeURIComponent(prefix)}`
	return {
		chatTab: `pal-chat-tab${suffix}`,
		computerTab: `computer-tab${suffix}`,
		chatPanel: `pal-chat-panel${suffix}`,
		computerPanel: `pal-computer-panel${suffix}`,
	}
}

export interface ComputerWorkspaceToolbarProps {
	idPrefix?: string
	palName: string
	activeTab: 'chat' | 'computer'
	paused?: boolean
	computerTabOpen: boolean
	split?: boolean
	profileOpen?: boolean
	chatOpen?: boolean
	floating?: boolean
	busy?: boolean
	onRename?: () => void
	onPause?: () => void
	onReboot?: () => void
	onDelete?: () => void
	onOpenChat?: () => void
	onToggleProfile?: () => void
	onOpenComputer?: () => void
	/** Closing the view leaves its computer running. */
	onCloseComputer?: () => void
	onToggleChat?: () => void
	onToggleFloating?: () => void
}

/** These actions also belong to the Pal's conversation tab in the shared strip. */
export function ComputerWorkspaceMenuItems({
	palName,
	paused = false,
	busy = false,
	onRename,
	onPause,
	onReboot,
	onDelete,
	onAccepted,
}: ComputerWorkspaceToolbarProps & { onAccepted?: () => void }) {
	const act = (action?: () => void) => {
		if (!action || busy) return
		onAccepted?.()
		action()
	}
	return (
		<>
			<Menu.Item
				className="computer-workspace-menu-item"
				disabled={busy || !onRename}
				onClick={() => act(onRename)}
			>
				<PencilIcon /> Rename
			</Menu.Item>
			<Menu.Item
				className="computer-workspace-menu-item"
				disabled={busy || !onPause}
				onClick={() => act(onPause)}
			>
				{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
				{paused ? `Resume ${palName}` : `Pause ${palName}`}
			</Menu.Item>
			<Menu.Item
				className="computer-workspace-menu-item"
				disabled={busy || !onReboot}
				onClick={() => act(onReboot)}
			>
				<RefreshIcon /> Reboot computer
			</Menu.Item>
			<Menu.Separator className="computer-workspace-menu-separator" />
			<Menu.Item
				className="computer-workspace-menu-item computer-workspace-menu-destructive"
				disabled={busy || !onDelete}
				onClick={() => act(onDelete)}
			>
				<TrashIcon /> Delete {palName}
			</Menu.Item>
		</>
	)
}

export function ComputerWorkspaceProfileToggle({
	palName,
	profileOpen = false,
	onToggleProfile,
}: ComputerWorkspaceToolbarProps) {
	return (
		<Button
			variant="ghost-muted"
			size="icon-xs"
			className="computer-workspace-tab-action computer-workspace-profile-toggle"
			aria-label={`${profileOpen ? 'Hide' : 'Show'} ${palName} profile`}
			aria-pressed={profileOpen}
			disabled={!onToggleProfile}
			onClick={onToggleProfile}
		>
			<SlidersHorizontal aria-hidden="true" />
		</Button>
	)
}

/** A view of the current Pal computer, never a second conversation owner. */
export function ComputerWorkspaceComputerTab({
	idPrefix,
	palName,
	activeTab,
	onOpenComputer,
	onCloseComputer,
	value = 'computer',
	shared = false,
	disabled = false,
}: ComputerWorkspaceToolbarProps & { value?: string; shared?: boolean; disabled?: boolean }) {
	const ids = computerWorkspaceIds(idPrefix)
	return (
		<div
			className={`computer-workspace-tab computer-workspace-computer-tab${shared ? ' conversation-tab' : ''}`}
			data-active={activeTab === 'computer'}
			onPointerDownCapture={(event) => {
				if (
					event.button !== 1 ||
					!(event.target instanceof Element) ||
					!event.target.closest('.computer-workspace-tab-label')
				)
					return
				event.preventDefault()
				event.stopPropagation()
			}}
		>
			<Tabs.Tab
				id={ids.computerTab}
				value={value}
				aria-controls={ids.computerPanel}
				aria-label={`${palName}’s computer`}
				disabled={disabled || !onOpenComputer}
				onAuxClick={(event) => {
					if (event.button !== 1 || disabled || !onCloseComputer) return
					event.preventDefault()
					event.stopPropagation()
					onCloseComputer()
				}}
				render={<Button variant="ghost" size="sm" className="computer-workspace-tab-label" />}
			>
				<MonitorIcon /> <span title={`${palName}’s computer`}>{palName}’s computer</span>
			</Tabs.Tab>
			<Button
				variant="ghost-muted"
				size="icon-xs"
				className="computer-workspace-tab-action computer-workspace-tab-close"
				aria-label="Close computer tab"
				disabled={disabled || !onCloseComputer}
				onClick={onCloseComputer}
			>
				<XIcon />
			</Button>
		</div>
	)
}

export function ComputerWorkspaceControls({
	activeTab,
	computerTabOpen,
	chatOpen = false,
	floating = false,
	onOpenComputer,
	onToggleChat,
	onToggleFloating,
	disabled = false,
}: ComputerWorkspaceToolbarProps & { disabled?: boolean }) {
	return (
		<div className="computer-workspace-view-controls">
			<Button
				variant="ghost-muted"
				size="icon-sm"
				aria-label="Open computer tab"
				className="computer-workspace-tab-add"
				disabled={disabled || !onOpenComputer || (computerTabOpen && activeTab === 'computer')}
				onClick={onOpenComputer}
			>
				<PlusIcon />
			</Button>
			{computerTabOpen && activeTab === 'computer' && (
				<div className="computer-workspace-layout-controls">
					<Button
						variant="ghost-muted"
						size="icon-sm"
						aria-label={chatOpen ? 'Hide chat panel' : 'Show chat panel'}
						aria-pressed={chatOpen}
						disabled={disabled || !onToggleChat}
						onClick={onToggleChat}
					>
						<PanelRightIcon />
					</Button>
					<Button
						variant="ghost-muted"
						size="icon-sm"
						aria-label={floating ? 'Dock chat panel' : 'Show floating chat'}
						aria-pressed={floating}
						disabled={disabled || !onToggleFloating}
						onClick={onToggleFloating}
					>
						<PictureInPicture2 aria-hidden="true" />
					</Button>
				</div>
			)}
		</div>
	)
}

/** Standalone consumers use the same Pal controls as the shared conversation strip. */
export function ComputerWorkspaceToolbar(props: ComputerWorkspaceToolbarProps) {
	const { palName, computerTabOpen, activeTab, split = false, onOpenChat, onOpenComputer } = props
	const ids = computerWorkspaceIds(props.idPrefix)
	const trigger = useRef<HTMLButtonElement>(null)
	const accepted = useRef(false)
	const selectedTab = computerTabOpen ? activeTab : 'chat'
	return (
		<Tabs.Root
			value={selectedTab}
			onValueChange={(value) => {
				if (value === 'chat') onOpenChat?.()
				else if (value === 'computer') onOpenComputer?.()
			}}
			render={
				<header
					className="computer-workspace-toolbar"
					aria-label={`${palName} workspace`}
					data-split={split && selectedTab === 'computer'}
				/>
			}
		>
			<Tabs.List className="computer-workspace-tabs" aria-label={`${palName} workspace tabs`}>
				<div className="computer-workspace-chat-group">
					<div
						className="computer-workspace-tab computer-workspace-chat-tab"
						data-active={selectedTab === 'chat'}
					>
						<Tabs.Tab
							id={ids.chatTab}
							data-pal-chat-tab=""
							value="chat"
							aria-controls={ids.chatPanel}
							aria-label={palName}
							disabled={!onOpenChat}
							render={<Button variant="ghost" size="sm" className="computer-workspace-tab-label" />}
						>
							<MessageCircle aria-hidden="true" /> <span title={palName}>{palName}</span>
						</Tabs.Tab>
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
										className="computer-workspace-tab-action"
										aria-label={`Actions for ${palName}`}
									/>
								}
							>
								<MoreHorizontalIcon />
							</Menu.Trigger>
							<Menu.Portal>
								<Menu.Positioner
									className="computer-workspace-menu-positioner"
									align="start"
									sideOffset={6}
								>
									<Menu.Popup
										className="computer-workspace-menu"
										aria-label={`${palName} actions`}
										finalFocus={() => (accepted.current ? false : (trigger.current ?? true))}
									>
										<ComputerWorkspaceMenuItems
											{...props}
											onAccepted={() => {
												accepted.current = true
											}}
										/>
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.Root>
						<ComputerWorkspaceProfileToggle {...props} />
					</div>
				</div>
				<div className="computer-workspace-computer-group">
					{computerTabOpen && <ComputerWorkspaceComputerTab {...props} />}
					<ComputerWorkspaceControls {...props} />
				</div>
			</Tabs.List>
		</Tabs.Root>
	)
}
