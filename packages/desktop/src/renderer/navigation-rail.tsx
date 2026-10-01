import { FoldersIcon, HistoryIcon, HomeIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Appearance } from './sidebar.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

export function NavigationRail({
	home,

	appearance,

	onHome,
	onProjects,
	onConversations,

	onAppearance,
}: {
	home: boolean
	appearance: Appearance
	onHome: () => void
	onProjects: () => void
	onConversations: () => void
	onAppearance: () => void
}) {
	const AppearanceIcon =
		appearance === 'dark' ? MoonIcon : appearance === 'light' ? SunIcon : MonitorIcon
	return (
		<nav className="navigation-rail" aria-label="Main navigation">
			<RailButton label="Home" active={home} onClick={onHome}>
				<HomeIcon />
			</RailButton>
			<RailButton label="Projects" onClick={onProjects}>
				<FoldersIcon />
			</RailButton>
			<RailButton label="Conversations" onClick={onConversations}>
				<HistoryIcon />
			</RailButton>
			<div className="rail-spacer" />
			<RailButton label={`Appearance: ${appearance}. Change appearance`} onClick={onAppearance}>
				<AppearanceIcon />
			</RailButton>
		</nav>
	)
}

function RailButton({
	label,
	active,
	expanded,
	disabled,
	onClick,
	children,
}: {
	label: string
	active?: boolean
	expanded?: boolean
	disabled?: boolean
	onClick: () => void
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
						aria-current={active && expanded === undefined ? 'page' : undefined}
						aria-expanded={expanded}
						aria-controls={expanded === undefined ? undefined : 'namzu-sidebar'}
						data-active={active || undefined}
						disabled={disabled}
						onClick={onClick}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipPopup side="right">{label}</TooltipPopup>
		</Tooltip>
	)
}
