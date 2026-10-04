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

export interface ComputerWorkspaceToolbarProps {
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

export function ComputerWorkspaceToolbar({
	palName,
	activeTab,
	paused = false,
	computerTabOpen,
	split = false,
	profileOpen = false,
	chatOpen = false,
	floating = false,
	busy = false,
	onRename,
	onPause,
	onReboot,
	onDelete,
	onOpenChat,
	onToggleProfile,
	onOpenComputer,
	onCloseComputer,
	onToggleChat,
	onToggleFloating,
}: ComputerWorkspaceToolbarProps) {
	const trigger = useRef<HTMLButtonElement>(null)
	const accepted = useRef(false)
	const selectedTab = computerTabOpen ? activeTab : 'chat'
	const act = (action?: () => void) => {
		if (!action || busy) return
		accepted.current = true
		action()
	}
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
							id="pal-chat-tab"
							value="chat"
							aria-controls="pal-chat-panel"
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
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.Root>
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
					</div>
				</div>
				<div className="computer-workspace-computer-group">
					{computerTabOpen && (
						<div
							className="computer-workspace-tab computer-workspace-computer-tab"
							data-active={selectedTab === 'computer'}
						>
							<Tabs.Tab
								id="computer-tab"
								value="computer"
								aria-controls="pal-computer-panel"
								aria-label={`${palName}’s computer`}
								disabled={!onOpenComputer}
								render={
									<Button variant="ghost" size="sm" className="computer-workspace-tab-label" />
								}
							>
								<MonitorIcon /> <span title={`${palName}’s computer`}>{palName}’s computer</span>
							</Tabs.Tab>
							<Button
								variant="ghost-muted"
								size="icon-xs"
								className="computer-workspace-tab-action computer-workspace-tab-close"
								aria-label="Close computer tab"
								disabled={!onCloseComputer}
								onClick={onCloseComputer}
							>
								<XIcon />
							</Button>
						</div>
					)}
					<Button
						variant="ghost-muted"
						size="icon-sm"
						aria-label="Open computer tab"
						className="computer-workspace-tab-add"
						disabled={!onOpenComputer || (computerTabOpen && activeTab === 'computer')}
						onClick={onOpenComputer}
					>
						<PlusIcon />
					</Button>
					{selectedTab === 'computer' && (
						<div className="computer-workspace-layout-controls">
							<Button
								variant="ghost-muted"
								size="icon-sm"
								aria-label={chatOpen ? 'Hide chat panel' : 'Show chat panel'}
								aria-pressed={chatOpen}
								disabled={!onToggleChat}
								onClick={onToggleChat}
							>
								<PanelRightIcon />
							</Button>
							<Button
								variant="ghost-muted"
								size="icon-sm"
								aria-label={floating ? 'Dock chat panel' : 'Show floating chat'}
								aria-pressed={floating}
								disabled={!computerTabOpen || !onToggleFloating}
								onClick={onToggleFloating}
							>
								<PictureInPicture2 aria-hidden="true" />
							</Button>
						</div>
					)}
				</div>
			</Tabs.List>
		</Tabs.Root>
	)
}
