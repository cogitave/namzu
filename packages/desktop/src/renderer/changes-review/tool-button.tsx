import type { ReactNode } from 'react'
import { Button } from '../ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip.js'

/** A compact icon button whose name is also its tooltip. */
export function ToolButton({
	label,
	tooltip = label,
	pressed,
	disabled,
	onClick,
	children,
}: {
	label: string
	tooltip?: ReactNode
	pressed?: boolean
	disabled?: boolean
	onClick?: () => void
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost-muted"
						size="icon-xs"
						aria-label={label}
						aria-pressed={pressed}
						disabled={disabled}
						onClick={onClick}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipPopup side="bottom">{tooltip}</TooltipPopup>
		</Tooltip>
	)
}
