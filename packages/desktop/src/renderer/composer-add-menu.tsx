import { Menu } from '@base-ui/react/menu'
import { type ReactNode, type RefObject, useRef, useState } from 'react'
import type { McpServerState, McpServersView } from '../shared/protocol.js'
import {
	type ComposerPlugin,
	type ComposerPluginInventory,
	usePluginInventory,
} from './composer-plugins.js'
import {
	BlocksIcon,
	ChevronRightIcon,
	LoaderCircleIcon,
	PaperclipIcon,
	PlugIcon,
	PlusIcon,
	SquareSlashIcon,
} from './icons.js'
import './menu.css'
import './composer-menus.css'
import { Button } from './ui/button.js'
import { SwitchMark } from './ui/switch.js'

export const TOOL_SERVER_STATE_WORDS: Record<McpServerState, string> = {
	connected: 'Connected',
	waiting: 'Needs approval',
	failed: 'Failed',
	idle: 'Not started',
}

export interface AddMenuPlugins {
	scope: string
	view?: ComposerPluginInventory
	loading: boolean
	disabled: boolean
	onOpen: () => void
	/** Opens the plugins page; absent while that page is not offered, and then the row is not drawn. */
	onOpenAll?: () => void
	onSetEnabled: (plugin: ComposerPlugin, enabled: boolean) => Promise<void>
}

export interface AddMenuToolServers {
	/** `undefined` while the list is read. */
	view: McpServersView | undefined
	/** Reads the list; called each time the menu opens. */
	onOpen: () => void
	/** Opens Settings, on the page that explains a server; a server's name goes to its row. */
	onManage: (server?: string) => void
}

const noop = async () => {}

/**
 * The plus menu. Rows: files, the "/" list, tool servers and plugins. A row that cannot work in
 * this conversation is left out, not greyed. Esc closes the side menu first, then the menu, and
 * the keyboard returns to the message box.
 */
export function ComposerAddMenu({
	open,
	onOpenChange,
	inputRef,
	hostRef,
	mac,
	attach,
	slash,
	toolServers,
	plugins,
	triggerClassName,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	inputRef: RefObject<HTMLTextAreaElement | null>
	/** The box the menu sits flush on. */
	hostRef: RefObject<HTMLElement | null>
	mac: boolean
	attach: { disabled: boolean; onAttach: () => void } | null
	slash: { onOpen: () => void } | null
	toolServers: AddMenuToolServers | null
	plugins: AddMenuPlugins | null
	triggerClassName?: string
}) {
	const inventory = usePluginInventory({
		scope: plugins?.scope ?? '',
		view: plugins?.view,
		loading: plugins?.loading ?? false,
		disabled: plugins?.disabled ?? true,
		onSetEnabled: plugins?.onSetEnabled ?? noop,
	})
	const trigger = useTriggerOffset(open, hostRef)
	return (
		<Menu.Root
			open={open}
			onOpenChange={(next) => {
				if (next) {
					inventory.clearError()
					toolServers?.onOpen()
					plugins?.onOpen()
				}
				onOpenChange(next)
			}}
		>
			<Menu.Trigger
				ref={trigger.ref}
				render={<Button variant="ghost-muted" size="icon-sm" />}
				className={triggerClassName}
				aria-label="Add"
			>
				<PlusIcon />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					className="conversation-actions-positioner"
					side="top"
					align="start"
					anchor={hostRef}
					sideOffset={0}
					alignOffset={trigger.offset}
					collisionPadding={8}
				>
					<Menu.Popup
						className="menu-popup composer-add-popup"
						aria-label="Add to the message"
						finalFocus={inputRef}
					>
						{attach && (
							<Menu.Item
								className="menu-item"
								disabled={attach.disabled}
								aria-keyshortcuts={mac ? 'Meta+U' : 'Control+U'}
								onClick={() => {
									inputRef.current?.focus()
									attach.onAttach()
								}}
							>
								<PaperclipIcon aria-hidden="true" />
								<span className="menu-label">Add files or photos</span>
								<kbd className="composer-add-hint" style={{ font: 'inherit' }}>
									{mac ? '⌘U' : 'Ctrl+U'}
								</kbd>
							</Menu.Item>
						)}
						{slash && (
							<Menu.Item className="menu-item" onClick={slash.onOpen}>
								<SquareSlashIcon aria-hidden="true" />
								<span className="menu-label">Slash commands</span>
							</Menu.Item>
						)}
						{toolServers && (
							<SubmenuRow icon={<BlocksIcon aria-hidden="true" />} label="Tool servers">
								<Menu.Item className="menu-item" onClick={() => toolServers.onManage()}>
									<span className="menu-label">Manage tool servers</span>
								</Menu.Item>
								<Menu.Separator className="menu-separator" />
								{toolServers.view === undefined && (
									<p className="composer-add-note">
										<LoaderCircleIcon className="size-3.5 animate-spin" /> Reading tool servers…
									</p>
								)}
								{toolServers.view?.error && (
									<p className="composer-add-note">{toolServers.view.error}</p>
								)}
								{toolServers.view &&
									toolServers.view.servers.length === 0 &&
									!toolServers.view.error && (
										<p className="composer-add-note">
											No tool servers are set up for this project.
										</p>
									)}
								{toolServers.view?.servers.map((server) => (
									<Menu.Item
										key={server.name}
										className="menu-item"
										title={server.reason ?? server.detail}
										onClick={() => toolServers.onManage(server.name)}
									>
										<span className="menu-label">{server.name}</span>
										<span className="composer-add-hint">
											{TOOL_SERVER_STATE_WORDS[server.state]}
										</span>
									</Menu.Item>
								))}
							</SubmenuRow>
						)}
						{plugins && (
							<SubmenuRow icon={<PlugIcon aria-hidden="true" />} label="Plugins">
								{plugins.onOpenAll && (
									<>
										<Menu.Item className="menu-item" onClick={plugins.onOpenAll}>
											<span className="menu-label">All plugins</span>
										</Menu.Item>
										<Menu.Separator className="menu-separator" />
									</>
								)}
								{plugins.loading && (
									<p className="composer-add-note">
										<LoaderCircleIcon className="size-3.5 animate-spin" /> Loading plugins…
									</p>
								)}
								{plugins.view?.notice && <p className="composer-add-note">{plugins.view.notice}</p>}
								{plugins.view?.live && !plugins.view.canChange && (
									<p className="composer-add-note">
										Finish the active work before changing plugins.
									</p>
								)}
								{inventory.error && (
									<p role="alert" className="composer-add-note" style={{ color: 'var(--error)' }}>
										{inventory.error}
									</p>
								)}
								{plugins.view &&
									plugins.view.plugins.length === 0 &&
									!plugins.view.notice &&
									!plugins.loading && (
										<p className="composer-add-note">No plugins are loaded in this conversation.</p>
									)}
								{plugins.view?.plugins.map((plugin) => {
									const on = plugin.status === 'enabled'
									return (
										<Menu.CheckboxItem
											key={`${plugin.scope}:${plugin.name}`}
											className="menu-item"
											checked={on}
											closeOnClick={false}
											disabled={!inventory.canChange(plugin)}
											title={plugin.description || undefined}
											onCheckedChange={() => void inventory.change(plugin)}
										>
											<span className="menu-label">{plugin.name}</span>
											<SwitchMark on={on} />
										</Menu.CheckboxItem>
									)
								})}
							</SubmenuRow>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

/** A row that opens a menu to its right, 2 px away and level with the row's bottom, as the plus menu opens upward. */
function SubmenuRow({
	icon,
	label,
	children,
}: {
	icon: ReactNode
	label: string
	children: ReactNode
}) {
	// A click opens the side menu and keeps it open: the hover that came first must not toggle it
	// shut, and a pointer drifting off the row afterwards must not close what was asked for.
	const [open, setOpen] = useState(false)
	const pressed = useRef(false)
	return (
		<Menu.SubmenuRoot
			open={open}
			onOpenChange={(next, details) => {
				if (details.reason === 'trigger-press') {
					pressed.current = true
					if (!next && open) return
				} else if (!next && pressed.current && details.reason === 'trigger-hover') return
				if (!next) pressed.current = false
				setOpen(next)
			}}
		>
			<Menu.SubmenuTrigger className="menu-item">
				{icon}
				<span className="menu-label">{label}</span>
				<ChevronRightIcon className="composer-add-chevron" aria-hidden="true" />
			</Menu.SubmenuTrigger>
			<Menu.Portal>
				<Menu.Positioner
					className="conversation-actions-positioner"
					side="right"
					align="end"
					sideOffset={2}
					alignOffset={-5}
					collisionPadding={8}
				>
					<Menu.Popup className="menu-popup composer-add-sub" aria-label={label}>
						{children}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.SubmenuRoot>
	)
}

/** How far the plus button sits from the box's left edge, so the menu's left lines up with the button's. */
function useTriggerOffset(open: boolean, hostRef: RefObject<HTMLElement | null>) {
	const [offset, setOffset] = useState(0)
	return {
		offset,
		ref: (node: HTMLElement | null) => {
			const host = hostRef.current
			if (!open || !node || !host) return
			const next = Math.round(node.getBoundingClientRect().left - host.getBoundingClientRect().left)
			if (next !== offset) setOffset(next)
		},
	}
}
