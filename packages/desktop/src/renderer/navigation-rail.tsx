import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { EngineUpdatesState } from '../shared/engine-update-protocol.js'
import type { UpdateState } from '../shared/update-protocol.js'
import { engineAnnouncement, engineBadge } from './engine-updates-model.js'
import {
	DownloadIcon,
	FoldersIcon,
	HistoryIcon,
	HomeFilledIcon,
	HomeIcon,
	PuzzleIcon,
	SettingsIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { updateAnnouncement, updateBadge } from './update-model.js'
import { useEngineUpdates } from './use-engine-updates.js'
import './navigation-rail.css'

export function NavigationRail({
	section,
	onHome,
	onSettings,
	update,
	onOpenUpdates,
}: {
	section: 'home' | 'spaces' | 'plugins' | 'settings'
	onHome: () => void
	onSettings: () => void
	/** Absent in a window that has no updater. */
	update?: { state: UpdateState; onOpen: () => void; onCheck: () => void }
	/** Opens Settings ▸ Updates, for programs that are behind. */
	onOpenUpdates?: () => void
}) {
	const engines = useEngineUpdates()
	return (
		<nav className="navigation-rail" aria-label="Main navigation">
			<RailButton label="Home" active={section === 'home'} onClick={onHome}>
				{section === 'home' ? <HomeFilledIcon /> : <HomeIcon />}
			</RailButton>
			<RailButton label="Spaces" unavailable tooltip="Spaces — in progress">
				<FoldersIcon />
			</RailButton>
			<RailButton label="Scheduled" unavailable tooltip="Scheduled — in progress">
				<HistoryIcon />
			</RailButton>
			<RailButton label="Plugins" unavailable tooltip="Plugins — in progress">
				<PuzzleIcon />
			</RailButton>
			<div className="rail-spacer" />
			{(update || (engines && onOpenUpdates)) && (
				<UpdateRailButton
					state={update?.state ?? { status: 'disabled' }}
					onOpen={update?.onOpen ?? (() => {})}
					engines={engines?.state}
					onOpenEngines={onOpenUpdates}
				/>
			)}
			<RailButton
				label="Settings"
				tooltip={`Settings (${typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘,' : 'Ctrl+,'})`}
				active={section === 'settings'}
				onClick={onSettings}
			>
				<SettingsIcon />
			</RailButton>
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
}: {
	state: UpdateState
	onOpen: () => void
	engines?: EngineUpdatesState
	onOpenEngines?: () => void
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
								aria-label={badge.label}
								onClick={click}
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
