import { Menu } from '@base-ui/react/menu'
import { Pause, PictureInPicture2, Play } from 'lucide-react'
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
	paused?: boolean
	computerTabOpen: boolean
	chatOpen?: boolean
	floating?: boolean
	busy?: boolean
	onRename?: () => void
	onPause?: () => void
	onReboot?: () => void
	onDelete?: () => void
	onOpenComputer?: () => void
	/** Closing the view leaves its computer running. */
	onCloseComputer?: () => void
	onToggleChat?: () => void
	onToggleFloating?: () => void
}

export function ComputerWorkspaceToolbar({
	palName,
	paused = false,
	computerTabOpen,
	chatOpen = false,
	floating = false,
	busy = false,
	onRename,
	onPause,
	onReboot,
	onDelete,
	onOpenComputer,
	onCloseComputer,
	onToggleChat,
	onToggleFloating,
}: ComputerWorkspaceToolbarProps) {
	const trigger = useRef<HTMLButtonElement>(null)
	const accepted = useRef(false)
	const act = (action?: () => void) => {
		if (!action || busy) return
		accepted.current = true
		action()
	}
	return (
		<header className="computer-workspace-toolbar" aria-label={`${palName} workspace`}>
			<div className="computer-workspace-identity">
				<h2 title={palName}>{palName}</h2>
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
			</div>
			<nav className="computer-workspace-tabs" aria-label="Computer tabs">
				{computerTabOpen && (
					<div className="computer-workspace-tab" data-active="true">
						<Button
							variant="ghost"
							size="sm"
							className="computer-workspace-tab-label"
							aria-label={`Show ${palName}’s computer`}
							aria-pressed="true"
							disabled={!onOpenComputer}
							onClick={onOpenComputer}
						>
							<MonitorIcon /> <span>{palName}’s computer</span>
						</Button>
						<Button
							variant="ghost-muted"
							size="icon-xs"
							className="computer-workspace-tab-close"
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
					disabled={!onOpenComputer || computerTabOpen}
					onClick={onOpenComputer}
				>
					<PlusIcon />
				</Button>
			</nav>
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
		</header>
	)
}
