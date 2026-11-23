import { useId, useRef, useState } from 'react'
import type { DesktopTurnHandoff } from '../shared/protocol.js'
import { describeHandoff } from './handoff-card-model.js'
import { ShieldAlertIcon } from './icons.js'
import './composer-approval.css'
import './composer-handoff.css'

/** The key that continues, written the way this computer writes it. */
const continueKey = () =>
	typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘↵' : 'Ctrl+Enter'

/**
 * A turn a tool paused because it needs the person: a sign-in, a check on a page, a second factor.
 * It sits where an approval does and says in plain words what to do, with Continue (the turn goes
 * on from where it stopped) and Stop (it is closed, nothing is lost). Typing a message instead
 * moves on without it, so the card never holds the conversation.
 */
export function ComposerHandoff({
	handoff,
	onContinue,
	onStop,
	onShowTab,
	disabled = false,
}: {
	handoff: DesktopTurnHandoff
	onContinue: () => unknown
	onStop: () => unknown
	/** Reveals and focuses the tab the page is in; given when the page is a tab of the Browser pane. */
	onShowTab?: () => void
	disabled?: boolean
}) {
	const card = describeHandoff(handoff)
	const textId = useId()
	const [busy, setBusy] = useState(false)
	const sent = useRef(false)
	const act = (run: () => unknown) => {
		// One press each: the answer takes a moment and a second press must not repeat it.
		if (sent.current || disabled) return
		sent.current = true
		setBusy(true)
		Promise.resolve(run())
			.catch(() => undefined)
			.finally(() => {
				sent.current = false
				setBusy(false)
			})
	}
	return (
		<section
			className="approval-surface handoff-surface"
			aria-label="Namzu is waiting for you"
			data-testid="handoff-card"
			onKeyDown={(event) => {
				// Esc stops it, as in the terminal; Ctrl+Enter (Cmd+Enter on a Mac) continues it, as Accept
				// and Send do on the other cards; a plain Enter is the focused button's own.
				if (event.defaultPrevented) return
				if (event.key === 'Escape') {
					event.preventDefault()
					act(onStop)
				} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
					event.preventDefault()
					act(onContinue)
				}
			}}
		>
			<div className="approval-card handoff-card" data-kind="handoff">
				<header className="approval-head">
					<ShieldAlertIcon aria-hidden="true" className="approval-head-icon" />
					<h3 className="approval-title" title={card.title}>
						{card.title}
					</h3>
				</header>
				<p className="handoff-text" id={textId}>
					{card.body}
				</p>
				{card.fallback && (
					<div className="handoff-fallback">
						<p className="handoff-fallback-lead">{card.fallback.lead}</p>
						<code className="handoff-command">{card.fallback.command}</code>
					</div>
				)}
				<footer className="approval-footer">
					<div className="approval-actions">
						{onShowTab && (
							<button
								type="button"
								className="approval-button"
								data-action="show-tab"
								aria-describedby={textId}
								title="Show the tab in the Browser pane"
								onClick={onShowTab}
							>
								Show the tab
							</button>
						)}
						<button
							type="button"
							className="approval-button"
							data-action="stop"
							aria-describedby={textId}
							disabled={disabled || busy}
							title="Stop · Esc. The turn closes; nothing is lost."
							aria-keyshortcuts="Escape"
							onClick={() => act(onStop)}
						>
							Stop
							<span className="approval-key" aria-hidden="true">
								Esc
							</span>
						</button>
						<button
							type="button"
							className="approval-button"
							data-action="continue"
							data-tone="accept"
							aria-describedby={textId}
							disabled={disabled || busy}
							title={`Continue the turn from where it stopped · ${continueKey()}`}
							aria-keyshortcuts="Control+Enter"
							onClick={() => act(onContinue)}
						>
							Continue
							<span className="approval-key" aria-hidden="true">
								{continueKey()}
							</span>
						</button>
					</div>
				</footer>
			</div>
		</section>
	)
}
