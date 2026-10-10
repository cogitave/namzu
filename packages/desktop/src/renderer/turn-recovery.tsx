import { useId, useState } from 'react'
import type { ChatMessage, DesktopTurnRetry } from '../shared/protocol.js'
import type { FailureAction, FriendlyFailure } from './friendly-errors.js'
import { MessageActions } from './message-actions.js'
import { MessageTime } from './message.js'
import { Button } from './ui/button.js'
import './turn-recovery.css'

type OtherAction = Exclude<FailureAction, 'try-again'>

const ACTION_LABEL: Record<OtherAction, string> = {
	settings: 'Open model settings',
	'new-conversation': 'Start a new conversation',
	continue: 'Continue without this reply',
	'copy-to-new': 'Copy to a new conversation',
}

/** The actions a set of failures offers, once each, with Retry only where it can really run. */
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
 * What a stopped reply says and what can be done: plain words first, then the same quiet action
 * row a settled reply ends with (Retry and Copy as icons, other ways on as small text, Details as
 * a text toggle, the time). Retry appears only when the runtime holds a target it can repeat.
 */
export function TurnRecovery({
	retry,
	failures = [],
	disabled,
	model,
	time,
	onRetry,
	onAction,
}: {
	retry?: DesktopTurnRetry
	failures?: readonly FriendlyFailure[]
	disabled?: boolean
	/** The model a retry will use; the icon then reads "Retry with <model>". */
	model?: string
	/** When the stop was observed; absent when the time is unknown. */
	time?: ChatMessage['time']
	onRetry?: () => void
	onAction?: (action: OtherAction) => void
}) {
	const [open, setOpen] = useState(false)
	const detailsId = useId()
	const canRetry = Boolean(retry && onRetry)
	if (failures.length === 0 && !canRetry) return null
	const actions = recoveryActions(failures, canRetry)
	const others = actions.filter((action): action is OtherAction => action !== 'try-again')
	const details = failures.map((failure) => failure.details).filter(Boolean)
	const copyText = [failures.map((failure) => failure.text).join('\n'), ...details]
		.filter(Boolean)
		.join('\n\n')
	const retryLabel = model ? `Retry with ${model}` : 'Retry'
	return (
		<div className="turn-recovery" role={failures.length ? 'alert' : undefined} aria-live="polite">
			{failures.map((failure) => (
				<p key={failure.text} className="turn-recovery-text">
					{failure.text}
				</p>
			))}
			<MessageActions
				className="message-actions-wrap"
				text={copyText}
				copyLabel="Copy"
				lead={
					time ? (
						<span className="message-actions-time">
							<MessageTime time={time} />
						</span>
					) : undefined
				}
				onRetry={canRetry ? onRetry : undefined}
				retryLabel={retryLabel}
				retryTooltip={retryLabel}
				retryDisabled={disabled}
				after={
					<>
						{others.map((action) => (
							<Button
								key={action}
								size="xs"
								variant="ghost-muted"
								className="message-actions-text"
								onClick={() => onAction?.(action)}
							>
								{ACTION_LABEL[action]}
							</Button>
						))}
						{details.length > 0 && (
							<Button
								size="xs"
								variant="ghost-muted"
								className="message-actions-text"
								aria-expanded={open}
								aria-controls={detailsId}
								onClick={() => setOpen((value) => !value)}
							>
								Details
							</Button>
						)}
					</>
				}
			/>
			{details.length > 0 && (
				<div id={detailsId} className="turn-recovery-details-text" hidden={!open}>
					{details.map((text) => (
						<p key={text}>{text}</p>
					))}
				</div>
			)}
		</div>
	)
}
