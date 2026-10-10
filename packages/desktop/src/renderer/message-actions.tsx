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
	retryLabel = 'Retry',
	retryTooltip = 'Retry: ask the same thing again',
	retryDisabled,
	copyLabel,
	after,
	className,
}: {
	text: string
	children?: ReactNode
	/** Present only on the newest reply once it has settled: asks the same thing again. */
	onRetry?: () => void
	/** The accessible name of the retry icon; a failed reply names the model it will use. */
	retryLabel?: string
	retryTooltip?: string
	retryDisabled?: boolean
	/** The accessible name of the copy icon. */
	copyLabel?: string
	/** Quiet items that follow Copy on the same row and share its baseline. */
	after?: ReactNode
	className?: string
}) {
	return (
		<div className={className ? `message-actions ${className}` : 'message-actions'}>
			{children}
			{onRetry && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								size="icon-xs"
								variant="ghost-muted"
								className="message-retry-button size-6"
								aria-label={retryLabel}
								disabled={retryDisabled}
								onClick={onRetry}
							/>
						}
					>
						<RefreshIcon aria-hidden="true" />
					</TooltipTrigger>
					<TooltipPopup>{retryTooltip}</TooltipPopup>
				</Tooltip>
			)}
			<CopyButton text={text} label={copyLabel} />
			{after}
		</div>
	)
}
