import type { DesktopTurnRetry } from '../shared/protocol.js'
import type { FailureAction, FriendlyFailure } from './friendly-errors.js'
import { Button } from './ui/button.js'
import './turn-recovery.css'

const ACTION_LABEL: Record<FailureAction, string> = {
	'try-again': 'Try again',
	settings: 'Open model settings',
	'new-conversation': 'Start a new conversation',
	continue: 'Continue without this reply',
	'copy-to-new': 'Copy to a new conversation',
}

/** The actions a set of failures offers, once each, with Try again only where it can really run. */
export function recoveryActions(
	failures: readonly FriendlyFailure[],
	canRetry: boolean,
): FailureAction[] {
	const out: FailureAction[] = []
	for (const failure of failures)
		for (const action of failure.actions)
			if (!out.includes(action) && (action !== 'try-again' || canRetry)) out.push(action)
	return out
}

/**
 * What a stopped reply says and what can be done: plain words first, the original message behind
 * "Details". "Try again" appears only when the runtime holds a target it can safely repeat.
 */
export function TurnRecovery({
	retry,
	failures = [],
	disabled,
	onRetry,
	onAction,
}: {
	retry?: DesktopTurnRetry
	failures?: readonly FriendlyFailure[]
	disabled?: boolean
	onRetry?: () => void
	onAction?: (action: Exclude<FailureAction, 'try-again'>) => void
}) {
	const canRetry = Boolean(retry && onRetry)
	if (failures.length === 0 && !canRetry) return null
	const actions = recoveryActions(failures, canRetry)
	// A repeatable reply always offers Try again, even when the words did not name it.
	if (canRetry && !actions.includes('try-again')) actions.unshift('try-again')
	const details = failures.map((failure) => failure.details).filter(Boolean)
	return (
		<div className="turn-recovery" role={failures.length ? 'alert' : undefined} aria-live="polite">
			{failures.map((failure) => (
				<p key={failure.text} className="turn-recovery-text">
					{failure.text}
				</p>
			))}
			{actions.length > 0 && (
				<div className="turn-recovery-actions">
					{actions.map((action) => (
						<Button
							key={action}
							variant={action === actions[0] ? 'default' : 'outline'}
							size="sm"
							disabled={action === 'try-again' ? disabled : false}
							onClick={() => {
								if (action === 'try-again') onRetry?.()
								else onAction?.(action)
							}}
						>
							{ACTION_LABEL[action]}
						</Button>
					))}
				</div>
			)}
			{details.length > 0 && (
				<details className="turn-recovery-details">
					<summary>Details</summary>
					{details.map((text) => (
						<p key={text}>{text}</p>
					))}
				</details>
			)}
		</div>
	)
}
