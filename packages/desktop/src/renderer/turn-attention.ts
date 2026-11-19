import type { ThreadState, TimelineEntry } from '../shared/projection.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'

/**
 * The bad news a finished piece of work holds, counted from what its rows say: a command that
 * ended badly, and an action the engine would not run. A person who declined something is not
 * bad news (it was their answer), so a declined row is in neither count.
 */
export interface TurnAttention {
	failedCommands: number
	notAllowed: number
}

export interface AttentionFlag {
	/** `error` for work that failed; `warn` for work that was refused. */
	tone: 'error' | 'warn'
	text: string
}

export function turnAttention(
	thread: ThreadState,
	entries: readonly TimelineEntry[],
): TurnAttention {
	let failedCommands = 0
	let notAllowed = 0
	// The call that handed the turn to the person (a sign-in page) did not fail: the turn waits for
	// them at it, so it is not counted as a failed command while the handoff is open.
	let handedOff: TimelineEntry | undefined
	if (thread.handoff)
		for (const entry of entries)
			if (entry.kind === 'tool' && entry.turn === thread.turn) handedOff = entry
	for (const entry of entries) {
		if (entry.kind !== 'tool') continue
		if (entry === handedOff) continue
		const tool = thread.tools[entry.id]
		if (!tool) continue
		const facts = tool.facts
		if (
			facts?.kind === 'failure' &&
			(facts.reason === 'blocked' || facts.reason === 'needs_administrator')
		) {
			notAllowed += 1
			continue
		}
		const presentation = toolTranscriptPresentation(thread, entry.id)
		if (presentation?.kind === 'command' && presentation.state === 'failed') failedCommands += 1
	}
	return { failedCommands, notAllowed }
}

/** The header's words for what went wrong, in plain terms; none when nothing did. */
export function attentionFlags(attention: TurnAttention): AttentionFlag[] {
	const flags: AttentionFlag[] = []
	const { failedCommands, notAllowed } = attention
	if (failedCommands > 0)
		flags.push({
			tone: 'error',
			text: failedCommands === 1 ? '1 command failed' : `${failedCommands} commands failed`,
		})
	if (notAllowed > 0)
		flags.push({
			tone: 'warn',
			text:
				notAllowed === 1 ? '1 action was not allowed' : `${notAllowed} actions were not allowed`,
		})
	return flags
}
