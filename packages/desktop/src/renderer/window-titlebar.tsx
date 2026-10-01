import { Menu } from '@base-ui/react/menu'
import { ArrowLeftIcon, ArrowRightIcon, PanelLeftIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WindowChrome, WindowMenu } from '../shared/protocol.js'
import { Button } from './ui/button.js'

export function WindowTitlebar({
	appearance,
	onBack,
	onForward,
	canGoBack,
	canGoForward,
	onToggleSidebar,
	sidebarExpanded,
	onOpenProject,
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
	onNewConversation: () => void
	newConversationDisabled?: boolean
	onError: (message: string) => void
}) {
	const [chrome, setChrome] = useState<WindowChrome>({
		platform: 'other',
		height: 32,
	})
	useEffect(() => {
		let current = true
		void window.namzu
			.windowChrome()
			.then((value) => {
				if (current) setChrome(value)
			})
			.catch((error: unknown) => {
				if (current) onError(error instanceof Error ? error.message : String(error))
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
				.catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
		}
		apply()
		media.addEventListener('change', apply)
		return () => media.removeEventListener('change', apply)
	}, [appearance, onError])
	const popup = (menu: WindowMenu, button: HTMLButtonElement) => {
		const bounds = button.getBoundingClientRect()
		void window.namzu
			.popupWindowMenu(menu, { x: bounds.left, y: bounds.bottom })
			.catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
	}
	return (
		<header
			className="window-titlebar"
			data-platform={chrome.platform}
			aria-label="Application window"
		>
			<div className="window-titlebar-content">
				<nav className="window-titlebar-navigation" aria-label="Window navigation">
					<Button
						variant="ghost-muted"
						size="icon-sm"
						className="window-titlebar-navigation-button"
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
						className="window-titlebar-navigation-button"
						aria-label="Go forward"
						title="Go forward"
						disabled={!canGoForward}
						onClick={onForward}
					>
						<ArrowRightIcon aria-hidden="true" />
					</Button>
					<Button
						variant="ghost-muted"
						size="icon-sm"
						className="window-titlebar-navigation-button"
						aria-label="Toggle sidebar"
						title="Toggle sidebar · Ctrl/Cmd+B"
						aria-controls="namzu-sidebar"
						aria-expanded={sidebarExpanded}
						onClick={onToggleSidebar}
					>
						<PanelLeftIcon aria-hidden="true" />
					</Button>
				</nav>
				<nav className="window-titlebar-menus" aria-label="Application menus">
					<Menu.Root>
						<Menu.Trigger
							render={<Button variant="ghost-muted" className="window-titlebar-menu" />}
						>
							File
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner className="z-[150] outline-none" align="start" sideOffset={4}>
								<Menu.Popup className="window-titlebar-popup dropdown-glass min-w-52 rounded-lg p-1 text-sm text-popover-foreground shadow-xl outline-none">
									<Menu.Item
										className="window-titlebar-item"
										onClick={onNewConversation}
										disabled={newConversationDisabled}
									>
										<span>New conversation</span>
										<kbd>{chrome.platform === 'darwin' ? '⌘N' : 'Ctrl+N'}</kbd>
									</Menu.Item>
									<Menu.Item className="window-titlebar-item" onClick={onOpenProject}>
										<span>Open project…</span>
										<kbd>{chrome.platform === 'darwin' ? '⌘O' : 'Ctrl+O'}</kbd>
									</Menu.Item>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
					{chrome.platform !== 'darwin' &&
						(['edit', 'view', 'window'] as const).map((menu) => (
							<Button
								key={menu}
								variant="ghost-muted"
								className="window-titlebar-menu"
								aria-haspopup="menu"
								onClick={(event) => popup(menu, event.currentTarget)}
							>
								{menu[0]?.toUpperCase()}
								{menu.slice(1)}
							</Button>
						))}
				</nav>
				<span className="window-titlebar-caption">Namzu</span>
			</div>
		</header>
	)
}
