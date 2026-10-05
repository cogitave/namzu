import type { DesktopTurnRetry } from '../shared/protocol.js'
import { Button } from './ui/button.js'

export function TurnRecovery({
	retry,
	notice,
	disabled,
	onRetry,
}: {
	retry?: DesktopTurnRetry
	notice?: string
	disabled?: boolean
	onRetry?: () => void
}) {
	if (!notice && (!retry || !onRetry)) return null
	return (
		<div className="flex flex-col items-start gap-2" aria-live="polite">
			{notice && <p className="notice">{notice}</p>}
			{retry && onRetry && (
				<Button variant="outline" size="sm" disabled={disabled} onClick={onRetry}>
					Retry turn
				</Button>
			)}
		</div>
	)
}
