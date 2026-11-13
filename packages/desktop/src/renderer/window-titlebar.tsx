import { Menu } from '@base-ui/react/menu'
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
	WindowChrome,
	WindowMenu,
	WindowMenuEntry,
	WindowMenuModel,
} from '../shared/protocol.js'
import { START_FROM_SCRATCH_LABEL, USE_EXISTING_FOLDER_LABEL } from './add-project-menu.js'
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CheckIcon,
	ChevronRightIcon,
	MenuIcon,
	PanelLeftIcon,
} from './icons.js'
import { plainErrorText } from './plain-error.js'
import { Button } from './ui/button.js'
import { acceleratorLabel, guessChromePlatform } from './window-menu-labels.js'

// A submenu opens to the side of its row, 4 from the menu it belongs to: the row is the popup's padding
// (4) and border (1) inside that menu's edge, so the offset from the row adds them.
const SUBMENU_GAP = 4
const POPUP_EDGE = 5
type MenuGroup = 'file' | WindowMenu
const GROUPS: readonly { id: MenuGroup; label: string }[] = [
	{ id: 'file', label: 'File' },
	{ id: 'edit', label: 'Edit' },
	{ id: 'view', label: 'View' },
	{ id: 'window', label: 'Window' },
]
const POPUP =
	'window-titlebar-popup dropdown-glass min-w-52 rounded-lg p-1 text-sm text-popover-foreground shadow-[var(--shadow-popover)] outline-none'

/**
 * The header's left cluster: the menu button (where the platform has no menu bar), the sidebar toggle,
 * back and forward. The window's own buttons are the system's, drawn over the right end of the band.
 */
export function WindowTitlebar({
	appearance,
	onBack,
	onForward,
	canGoBack,
	canGoForward,
	onToggleSidebar,
	sidebarExpanded,
	onOpenProject,
	onCreateProject,
	onNewConversation,
	newConversationDisabled = false,
	onError,
}: {
	appearance: 'light' | 'dark' | 'system'
	onBack: () => void
	onForward: () => void
	canGoBack: boolean
	canGoForward: boolean
	onToggleSidebar: () => void
	sidebarExpanded: boolean
	onOpenProject: () => void
	onCreateProject?: () => void
	onNewConversation: () => void
	newConversationDisabled?: boolean
	onError: (message: string) => void
}) {
	const [chrome, setChrome] = useState<WindowChrome>(() => ({
		platform: guessChromePlatform(typeof navigator === 'undefined' ? '' : navigator.platform),
		height: 36,
	}))
	// The page's rules place the header's content by the platform: the window's buttons at the right on
	// Windows and Linux, the traffic lights at the left on macOS.
	useLayoutEffect(() => {
		document.documentElement.dataset.chromePlatform = chrome.platform
	}, [chrome.platform])
	useEffect(() => {
		let current = true
		void window.namzu
			.windowChrome()
			.then((value) => {
				if (current) setChrome(value)
			})
			.catch((error: unknown) => {
				if (current) onError(plainErrorText(error, 'set up the window'))
			})
		return () => {
			current = false
		}
	}, [onError])
	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)')
		const apply = () => {
			const resolved =
				appearance === 'dark' || (appearance === 'system' && media.matches) ? 'dark' : 'light'
			void window.namzu
				.setWindowAppearance(resolved)
				.catch((error: unknown) => onError(plainErrorText(error, 'change the appearance')))
		}
		apply()
		media.addEventListener('change', apply)
		return () => media.removeEventListener('change', apply)
	}, [appearance, onError])
	return (
		<header
			className="window-titlebar"
			data-platform={chrome.platform}
			aria-label="Application window"
		>
			<nav className="window-titlebar-cluster" aria-label="Window navigation">
				{chrome.platform !== 'darwin' && (
					<ApplicationMenu
						mac={false}
						onOpenProject={onOpenProject}
						onCreateProject={onCreateProject}
						onNewConversation={onNewConversation}
						newConversationDisabled={newConversationDisabled}
						onError={onError}
					/>
				)}
				<Button
					variant="ghost-muted"
					size="icon-sm"
					className="window-titlebar-button"
					aria-label="Toggle sidebar"
					title="Toggle sidebar · Ctrl/Cmd+B"
					aria-controls="namzu-sidebar"
					aria-expanded={sidebarExpanded}
					onClick={onToggleSidebar}
				>
					<PanelLeftIcon aria-hidden="true" />
				</Button>
				<Button
					variant="ghost-muted"
					size="icon-sm"
					className="window-titlebar-button"
					aria-label="Go back"
					title="Go back"
					disabled={!canGoBack}
					onClick={onBack}
				>
					<ArrowLeftIcon aria-hidden="true" />
				</Button>
				<Button
					variant="ghost-muted"
					size="icon-sm"
					className="window-titlebar-button"
					aria-label="Go forward"
					title="Go forward"
					disabled={!canGoForward}
					onClick={onForward}
				>
					<ArrowRightIcon aria-hidden="true" />
				</Button>
			</nav>
		</header>
	)
}

function Row({
	entry,
	mac,
	onRun,
}: {
	entry: WindowMenuEntry
	mac: boolean
	onRun: (entry: WindowMenuEntry) => void
}) {
	if (entry.kind === 'separator') return <Menu.Separator className="window-titlebar-separator" />
	const keys = entry.accelerator ? acceleratorLabel(entry.accelerator, mac) : undefined
	const label = (
		<>
			<span>{entry.label}</span>
			{keys && <kbd>{keys}</kbd>}
		</>
	)
	if (entry.kind === 'checkbox')
		return (
			<Menu.CheckboxItem
				className="window-titlebar-item"
				checked={entry.checked === true}
				disabled={!entry.enabled}
				closeOnClick
				onCheckedChange={() => onRun(entry)}
			>
				{label}
				<span className="window-titlebar-check" aria-hidden="true">
					{entry.checked && <CheckIcon />}
				</span>
			</Menu.CheckboxItem>
		)
	return (
		<Menu.Item
			className="window-titlebar-item"
			disabled={!entry.enabled}
			onClick={() => onRun(entry)}
		>
			{label}
		</Menu.Item>
	)
}

/**
 * One menu with File, Edit, View and Window as rows, each opening its commands beside it. File is the
 * app's own; the other three are the application menu's items as the main process holds them, so a
 * shortcut and a row run the same command.
 */
function ApplicationMenu({
	mac,
	onOpenProject,
	onCreateProject,
	onNewConversation,
	newConversationDisabled,
	onError,
}: {
	mac: boolean
	onOpenProject: () => void
	onCreateProject?: () => void
	onNewConversation: () => void
	newConversationDisabled: boolean
	onError: (message: string) => void
}) {
	const [open, setOpen] = useState(false)
	const [model, setModel] = useState<WindowMenuModel>({ edit: [], view: [], window: [] })
	const button = useRef<HTMLButtonElement>(null)
	// Edit's commands act on the field that had focus before the menu opened, so a command that ran
	// gives focus back there; leaving with Escape gives it to the button.
	const before = useRef<HTMLElement | null>(null)
	const pending = useRef<(() => void) | null>(null)
	const ranCommand = useRef(false)
	const refresh = useCallback(() => {
		void window.namzu
			.windowMenuModel()
			.then(setModel)
			.catch((error: unknown) => onError(plainErrorText(error, 'read the menu')))
	}, [onError])
	useEffect(() => refresh(), [refresh])
	const change = useCallback(
		(next: boolean) => {
			if (next) {
				const active = document.activeElement
				before.current = active instanceof HTMLElement && active !== button.current ? active : null
				pending.current = null
				refresh()
			}
			setOpen(next)
		},
		[refresh],
	)
	// Alt on its own opens the menu, as it does a menu bar; Alt with another key is that key's.
	useEffect(() => {
		let lone = false
		const down = (event: KeyboardEvent) => {
			lone =
				event.key === 'Alt' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.shiftKey
		}
		const up = (event: KeyboardEvent) => {
			if (event.key === 'Alt' && lone) {
				lone = false
				event.preventDefault()
				button.current?.focus()
				change(true)
			}
		}
		const cancel = () => {
			lone = false
		}
		window.addEventListener('keydown', down, true)
		window.addEventListener('keyup', up, true)
		window.addEventListener('pointerdown', cancel, true)
		return () => {
			window.removeEventListener('keydown', down, true)
			window.removeEventListener('keyup', up, true)
			window.removeEventListener('pointerdown', cancel, true)
		}
	}, [change])
	const run = (action: () => void) => {
		pending.current = action
		ranCommand.current = true
	}
	const runNative = (entry: WindowMenuEntry) =>
		run(() => {
			void window.namzu
				.runWindowMenuItem(entry.id)
				.catch((error: unknown) => onError(plainErrorText(error, 'run the command')))
		})
	const file: ReactNode = (
		<>
			<Menu.Item
				className="window-titlebar-item"
				onClick={() => run(onNewConversation)}
				disabled={newConversationDisabled}
			>
				<span>New conversation</span>
				<kbd>{acceleratorLabel('CmdOrCtrl+N', mac)}</kbd>
			</Menu.Item>
			{onCreateProject && (
				<Menu.Item className="window-titlebar-item" onClick={() => run(onCreateProject)}>
					<span>{START_FROM_SCRATCH_LABEL}</span>
				</Menu.Item>
			)}
			<Menu.Item className="window-titlebar-item" onClick={() => run(onOpenProject)}>
				<span>{USE_EXISTING_FOLDER_LABEL}</span>
				<kbd>{acceleratorLabel('CmdOrCtrl+O', mac)}</kbd>
			</Menu.Item>
		</>
	)
	return (
		<Menu.Root
			open={open}
			onOpenChange={change}
			onOpenChangeComplete={(next) => {
				if (next) return
				const action = pending.current
				pending.current = null
				ranCommand.current = false
				action?.()
			}}
		>
			<Menu.Trigger
				ref={button}
				render={
					<Button
						variant="ghost-muted"
						size="icon-sm"
						className="window-titlebar-button"
						aria-label="Menu"
						title="Menu · Alt"
					/>
				}
			>
				<MenuIcon aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="z-(--z-popover) outline-none" align="start" sideOffset={4}>
					<Menu.Popup
						className={POPUP}
						aria-label="Menu"
						finalFocus={() =>
							ranCommand.current && before.current?.isConnected ? before.current : button.current
						}
					>
						{GROUPS.map(({ id, label }) => {
							const entries = id === 'file' ? [] : model[id]
							if (id !== 'file' && entries.length === 0) return null
							return (
								<Menu.SubmenuRoot key={id}>
									<Menu.SubmenuTrigger className="window-titlebar-item" data-menu-group={id}>
										<span>{label}</span>
										<ChevronRightIcon className="window-titlebar-chevron" aria-hidden="true" />
									</Menu.SubmenuTrigger>
									<Menu.Portal>
										<Menu.Positioner
											className="z-(--z-popover) outline-none"
											side="right"
											align="start"
											sideOffset={SUBMENU_GAP + POPUP_EDGE}
										>
											<Menu.Popup className={POPUP} aria-label={label}>
												{id === 'file'
													? file
													: entries.map((entry, index) => (
															<Row
																key={entry.id || `separator-${index}`}
																entry={entry}
																mac={mac}
																onRun={runNative}
															/>
														))}
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.SubmenuRoot>
							)
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
