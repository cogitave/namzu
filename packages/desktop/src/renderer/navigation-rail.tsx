import { Menu } from '@base-ui/react/menu'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import type { UpdateState } from '../shared/update-protocol.js'
import { AddProjectItems } from './add-project-menu.js'
import {
	DownloadIcon,
	FoldersFilledIcon,
	FoldersIcon,
	HistoryIcon,
	HomeFilledIcon,
	HomeIcon,
	MoreHorizontalIcon,
	PanelLeftIcon,
	PuzzleFilledIcon,
	PuzzleIcon,
	SettingsIcon,
	UserRoundIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { updateAnnouncement, updateBadge, updateMenuEntry } from './update-model.js'
import './navigation-rail.css'

export function NavigationRail({
	section,
	onHome,
	onSpaces,
	onPlugins,
	onSettings,
	onOpenProject,
	onCreateProject,
	onToggleSidebar,
	openProjectDisabled = false,
	update,
}: {
	section: 'home' | 'spaces' | 'plugins' | 'settings'
	onHome: () => void
	onSpaces: () => void
	onPlugins: () => void
	onSettings: () => void
	onOpenProject: () => void
	onCreateProject?: () => void
	onToggleSidebar: () => void
	openProjectDisabled?: boolean
	/** Absent in a window that has no updater. */
	update?: { state: UpdateState; onOpen: () => void; onCheck: () => void }
}) {
	const moreTrigger = useRef<HTMLButtonElement>(null)
	const profileTrigger = useRef<HTMLButtonElement>(null)
	return (
		<nav className="navigation-rail" aria-label="Main navigation">
			<RailButton label="Home" active={section === 'home'} onClick={onHome}>
				{section === 'home' ? <HomeFilledIcon /> : <HomeIcon />}
			</RailButton>
			<RailButton label="Spaces" active={section === 'spaces'} onClick={onSpaces}>
				{section === 'spaces' ? <FoldersFilledIcon /> : <FoldersIcon />}
			</RailButton>
			<RailButton
				label="Scheduled"
				unavailable
				tooltip="Scheduled — not available in the desktop app yet."
			>
				<HistoryIcon />
			</RailButton>
			<RailButton label="Plugins" active={section === 'plugins'} onClick={onPlugins}>
				{section === 'plugins' ? <PuzzleFilledIcon /> : <PuzzleIcon />}
			</RailButton>
			<RailMenuRoot triggerRef={moreTrigger}>
				<RailMenuTrigger label="More" triggerRef={moreTrigger}>
					<MoreHorizontalIcon />
				</RailMenuTrigger>
				<RailMenuPopup label="More actions" triggerRef={moreTrigger}>
					<AddProjectItems
						itemClassName="rail-menu-item"
						disabled={openProjectDisabled}
						onCreate={onCreateProject}
						onOpen={onOpenProject}
					/>
					<Menu.Item className="rail-menu-item" onClick={onToggleSidebar}>
						<PanelLeftIcon />
						Toggle sidebar
					</Menu.Item>
				</RailMenuPopup>
			</RailMenuRoot>
			<div className="rail-spacer" />
			<RailButton
				label="Settings"
				tooltip={`Settings (${typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘,' : 'Ctrl+,'})`}
				active={section === 'settings'}
				onClick={onSettings}
			>
				<SettingsIcon />
			</RailButton>
			{update && <UpdateRailButton state={update.state} onOpen={update.onOpen} />}
			<RailMenuRoot triggerRef={profileTrigger}>
				<RailMenuTrigger label="Profile" profile triggerRef={profileTrigger}>
					<span className="rail-profile-avatar" aria-hidden="true">
						<UserRoundIcon />
					</span>
				</RailMenuTrigger>
				<RailMenuPopup label="Profile" align="end" triggerRef={profileTrigger}>
					<div className="rail-profile-copy">Namzu on this device</div>
					<Menu.Item className="rail-menu-item" onClick={onSettings}>
						<SettingsIcon />
						Settings…
					</Menu.Item>
					{update && <UpdateMenuItem state={update.state} update={update} />}
				</RailMenuPopup>
			</RailMenuRoot>
		</nav>
	)
}

function UpdateMenuItem({
	state,
	update,
}: {
	state: UpdateState
	update: { onOpen: () => void; onCheck: () => void }
}) {
	const entry = updateMenuEntry(state)
	if (!entry) return null
	return (
		<>
			<Menu.Separator className="rail-menu-separator" />
			<Menu.Item
				className="rail-menu-item"
				onClick={entry.action === 'check' ? update.onCheck : update.onOpen}
			>
				<DownloadIcon />
				{entry.label}
			</Menu.Item>
		</>
	)
}

/** A real button above the avatar for an installable update, announced once when it appears. */
function UpdateRailButton({ state, onOpen }: { state: UpdateState; onOpen: () => void }) {
	const badge = updateBadge(state)
	const previous = useRef<UpdateState>(state)
	const [announcement, setAnnouncement] = useState('')
	useEffect(() => {
		setAnnouncement(updateAnnouncement(previous.current, state))
		previous.current = state
	}, [state])
	return (
		<>
			<output className="sr-only" aria-live="polite">
				{announcement}
			</output>
			{badge.visible && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost-muted"
								size="icon"
								className="rail-button rail-update-button"
								aria-label={badge.label}
								onClick={onOpen}
							/>
						}
					>
						<span className="rail-update-badge" aria-hidden="true">
							<DownloadIcon />
						</span>
					</TooltipTrigger>
					<TooltipPopup side="right">{badge.tooltip}</TooltipPopup>
				</Tooltip>
			)}
		</>
	)
}

function RailMenuRoot({
	triggerRef,
	children,
}: { triggerRef: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
	const restoreOnClose = useRef(false)
	return (
		<Menu.Root
			onOpenChange={(open, details) => {
				if (open) restoreOnClose.current = false
				else if (details.reason === 'item-press' || details.reason === 'escape-key')
					restoreOnClose.current = true
			}}
			onOpenChangeComplete={(open) => {
				if (open || !restoreOnClose.current) return
				restoreOnClose.current = false
				const focused = document.activeElement
				// An accepted folder action can already have moved to the visible composer.
				if (focused instanceof HTMLTextAreaElement && focused.getClientRects().length) return
				triggerRef.current?.focus({ preventScroll: true })
			}}
		>
			{children}
		</Menu.Root>
	)
}

function RailButton({
	label,
	tooltip = label,
	active,
	unavailable,
	onClick,
	children,
}: {
	label: string
	tooltip?: string
	active?: boolean
	unavailable?: boolean
	onClick?: () => void
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost-muted"
						size="icon"
						className="rail-button"
						aria-label={label}
						aria-current={active ? 'page' : undefined}
						aria-disabled={unavailable || undefined}
						data-active={active || undefined}
						onClick={onClick}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipPopup side="right">{tooltip}</TooltipPopup>
		</Tooltip>
	)
}

function RailMenuTrigger({
	label,
	profile,
	triggerRef,
	children,
}: {
	label: string
	profile?: boolean
	triggerRef: RefObject<HTMLButtonElement | null>
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Menu.Trigger
						render={
							<Button
								ref={triggerRef}
								variant="ghost-muted"
								size="icon"
								className={`rail-button${profile ? ' rail-profile-button' : ''}`}
								aria-label={label}
							/>
						}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipPopup side="right">{label}</TooltipPopup>
		</Tooltip>
	)
}

function RailMenuPopup({
	label,
	align = 'start',
	triggerRef,
	children,
}: {
	label: string
	align?: 'start' | 'end'
	triggerRef: RefObject<HTMLButtonElement | null>
	children: ReactNode
}) {
	return (
		<Menu.Portal>
			<Menu.Positioner className="rail-menu-positioner" side="right" align={align} sideOffset={8}>
				<Menu.Popup className="rail-menu" aria-label={label} finalFocus={triggerRef}>
					{children}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	)
}
