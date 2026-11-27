import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { EngineUpdatesState } from '../shared/engine-update-protocol.js'
import type { UpdateState } from '../shared/update-protocol.js'
import { engineAnnouncement, engineBadge } from './engine-updates-model.js'
import { pageEntries } from './extensions-model.js'
import { openExtensionPage, openExtensionsPage, useExtensionsSnapshot } from './extensions-store.js'
import {
	CustomizeIcon,
	DownloadIcon,
	HomeFilledIcon,
	HomeIcon,
	PuzzleIcon,
	SearchIcon,
	SettingsIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { updateAnnouncement, updateBadge } from './update-model.js'
import { useEngineUpdates } from './use-engine-updates.js'
import './extension-page-pane.css'
import './navigation-rail.css'

export function NavigationRail({
	section,
	onHome,
	onSearch,
	onCustomize,
	onSettings,
	update,
	onOpenUpdates,
}: {
	section: 'home' | 'spaces' | 'customize' | 'settings'
	onHome: () => void
	/** Opens the search the sidebar's magnifier opens; the collapsed rail keeps it one click away. */
	onSearch?: () => void
	/** Opens the Customize page: skills, connectors and plugins. */
	onCustomize?: () => void
	onSettings: () => void
	/** Absent in a window that has no updater. */
	update?: { state: UpdateState; onOpen: () => void; onCheck: () => void }
	/** Opens Settings ▸ Updates, for programs that are behind. */
	onOpenUpdates?: () => void
}) {
	const engines = useEngineUpdates()
	return (
		<nav className="navigation-rail" aria-label="Main navigation">
			<div className="rail-band">
				<RailButton control="home" label="Home" active={section === 'home'} onClick={onHome}>
					{section === 'home' ? <HomeFilledIcon /> : <HomeIcon />}
				</RailButton>
			</div>
			{onSearch && (
				<div className="rail-stack rail-stack-top">
					<RailButton
						control="search"
						label="Search conversations"
						tooltip="Search conversations"
						onClick={onSearch}
					>
						<SearchIcon />
					</RailButton>
				</div>
			)}
			<div className="rail-spacer" />
			{/* The collapsed rail is one button wide: everything above the foot's line stacks in one column. */}
			<div className="rail-stack">
				{(update || (engines && onOpenUpdates)) && (
					<UpdateRailButton
						state={update?.state ?? { status: 'disabled' }}
						onOpen={update?.onOpen ?? (() => {})}
						engines={engines?.state}
						onOpenEngines={onOpenUpdates}
					/>
				)}
				<ExtensionsRailButton />
				{onCustomize && (
					<RailButton
						control="customize"
						label="Customize"
						active={section === 'customize'}
						onClick={onCustomize}
					>
						<CustomizeIcon />
					</RailButton>
				)}
			</div>
			<div className="rail-foot">
				<RailButton
					control="settings"
					label="Settings"
					tooltip={settingsTooltip()}
					active={section === 'settings'}
					onClick={onSettings}
				>
					<SettingsIcon />
				</RailButton>
			</div>
		</nav>
	)
}

/** Opens the Extensions page; there only when the engine offers extensions or one is added. */
function ExtensionsRailButton({ side }: { side?: 'right' | 'top' }) {
	const { supported, rows } = useExtensionsSnapshot()
	if (supported !== true && rows.length === 0) return null
	return (
		<>
			{/* The sidebar entries the extensions drew: their name, an accent dot, and nothing else of theirs. */}
			{pageEntries(rows, 'sidebar').map((p) => (
				<RailButton
					key={`${p.extensionId}/${p.pageId}`}
					control="extension-page"
					label={p.title}
					tooltip={`${p.title} (${p.name})`}
					{...(side ? { side } : {})}
					onClick={() => openExtensionPage(p.extensionId, p.pageId)}
				>
					<span className="rail-extension-badge" aria-hidden="true">
						{p.title.slice(0, 1).toUpperCase()}
						<span className="rail-extension-dot" style={{ background: p.accent }} />
					</span>
				</RailButton>
			))}
			<RailButton
				control="extensions"
				label="Extensions"
				{...(side ? { side } : {})}
				onClick={openExtensionsPage}
			>
				<PuzzleIcon />
			</RailButton>
		</>
	)
}

function settingsTooltip(): string {
	return `Settings (${typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘,' : 'Ctrl+,'})`
}

/**
 * The same controls at the bottom of an open sidebar. The rail is the collapsed sidebar: while the
 * sidebar is open the rail is not drawn and its controls live here, with the same names, tooltips,
 * badge and announcement. Home is only here where the sidebar has no "New conversation" row of its
 * own to lead to the same place (the Settings and Plugins sidebars).
 */
export function SidebarFoot({
	section,
	onHome,
	onCustomize,
	onSettings,
	update,
	onOpenUpdates,
}: {
	section: 'home' | 'spaces' | 'customize' | 'settings'
	onHome?: () => void
	onCustomize?: () => void
	onSettings: () => void
	update?: { state: UpdateState; onOpen: () => void; onCheck: () => void }
	onOpenUpdates?: () => void
}) {
	const engines = useEngineUpdates()
	return (
		<nav className="sidebar-foot" aria-label="Main navigation">
			{onHome && (
				<RailButton control="home" label="Home" side="top" onClick={onHome}>
					<HomeIcon />
				</RailButton>
			)}
			<ExtensionsRailButton side="top" />
			{onCustomize && (
				<RailButton
					control="customize"
					label="Customize"
					side="top"
					active={section === 'customize'}
					onClick={onCustomize}
				>
					<CustomizeIcon />
				</RailButton>
			)}
			<RailButton
				control="settings"
				label="Settings"
				tooltip={settingsTooltip()}
				side="top"
				active={section === 'settings'}
				onClick={onSettings}
			>
				<SettingsIcon />
			</RailButton>
			{(update || (engines && onOpenUpdates)) && (
				<UpdateRailButton
					state={update?.state ?? { status: 'disabled' }}
					onOpen={update?.onOpen ?? (() => {})}
					engines={engines?.state}
					onOpenEngines={onOpenUpdates}
					side="top"
				/>
			)}
		</nav>
	)
}

/**
 * A real button directly above Settings for an installable update, announced once when it appears. The app's
 * own update comes first (it is a restart); programs that are behind show the same button otherwise.
 */
function UpdateRailButton({
	state,
	onOpen,
	engines,
	onOpenEngines,
	side = 'right',
}: {
	state: UpdateState
	onOpen: () => void
	engines?: EngineUpdatesState
	onOpenEngines?: () => void
	side?: 'right' | 'top'
}) {
	const appBadge = updateBadge(state)
	const programBadge = onOpenEngines ? engineBadge(engines) : ({ visible: false } as const)
	const badge = appBadge.visible ? appBadge : programBadge
	const click = appBadge.visible ? onOpen : onOpenEngines
	const previous = useRef<UpdateState>(state)
	const previousEngines = useRef<EngineUpdatesState | undefined>(engines)
	const [announcement, setAnnouncement] = useState('')
	useEffect(() => {
		setAnnouncement(
			updateAnnouncement(previous.current, state) ||
				engineAnnouncement(previousEngines.current, engines),
		)
		previous.current = state
		previousEngines.current = engines
	}, [state, engines])
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
								data-frame-control="update"
								aria-label={badge.label}
								onClick={click}
							/>
						}
					>
						<span className="rail-update-badge" aria-hidden="true">
							<DownloadIcon />
						</span>
					</TooltipTrigger>
					<TooltipPopup side={side}>{badge.tooltip}</TooltipPopup>
				</Tooltip>
			)}
		</>
	)
}

function RailButton({
	control,
	label,
	tooltip = label,
	side = 'right',
	active,
	onClick,
	children,
}: {
	/** Names the control for the hand-over of focus when the rail and the foot swap places. */
	control: 'home' | 'search' | 'settings' | 'extensions' | 'extension-page' | 'customize'
	label: string
	tooltip?: string
	side?: 'right' | 'top'
	active?: boolean
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
						data-frame-control={control}
						aria-label={label}
						aria-current={active ? 'page' : undefined}
						data-active={active || undefined}
						onClick={onClick}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipPopup side={side}>{tooltip}</TooltipPopup>
		</Tooltip>
	)
}
