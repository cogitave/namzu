import type { ReactNode } from 'react'
import { CopyButton } from './copy-button.js'
import { RefreshIcon } from './icons.js'
import './message-actions.css'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

/** Settled answer actions share one quiet, stable row. */
export function MessageActions({
	text,
	children,
	onRetry,
}: {
	text: string
	children?: ReactNode
	/** Present only on the newest reply once it has settled: asks the same thing again. */
	onRetry?: () => void
}) {
	return (
		<div className="message-actions">
			{children}
			{onRetry && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								size="icon-xs"
								variant="ghost-muted"
								className="message-retry-button size-6"
								aria-label="Retry"
								onClick={onRetry}
							/>
						}
					>
						<RefreshIcon aria-hidden="true" />
					</TooltipTrigger>
					<TooltipPopup>Retry: ask the same thing again</TooltipPopup>
				</Tooltip>
			)}
			<CopyButton text={text} />
		</div>
	)
}
