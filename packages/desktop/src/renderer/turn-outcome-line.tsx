import type { OutcomeVerdict, TurnOutcomeSummary } from '../shared/outcome-protocol.js'
import type { AttentionFlag } from './turn-attention.js'
import './turn-outcome-line.css'

/**
 * One status mark: green when a check passed on the final state, red when one failed, amber for
 * every verdict that is not a pass and not a failure (not checked, hidden by a pipe, checked
 * before the last change). The words beside it carry the meaning, so colour is never alone.
 */
export function outcomeTone(verdict: OutcomeVerdict): 'ok' | 'error' | 'warn' {
	return verdict === 'checked' ? 'ok' : verdict === 'failing' ? 'error' : 'warn'
}

/** The line under a finished turn: what changed and what the kernel's record says about checking it. */
export function TurnOutcomeLine({ outcome }: { outcome: TurnOutcomeSummary | undefined }) {
	if (!outcome?.line) return null
	return (
		<p className="turn-outcome-line" data-outcome-verdict={outcome.verdict}>
			<span
				className="turn-outcome-mark"
				data-tone={outcomeTone(outcome.verdict)}
				aria-hidden="true"
			/>
			<span className="turn-outcome-text">{outcome.line}</span>
		</p>
	)
}

/** What a finished work group's header says went wrong, each with its own mark. */
export function AttentionFlags({ flags }: { flags: readonly AttentionFlag[] }) {
	if (flags.length === 0) return null
	return (
		<span className="activity-flags">
			{flags.map((flag) => (
				<span key={flag.text} className="activity-flag" data-tone={flag.tone}>
					<span className="turn-outcome-mark" data-tone={flag.tone} aria-hidden="true" />
					{flag.text}
				</span>
			))}
		</span>
	)
}
