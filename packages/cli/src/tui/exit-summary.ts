import { terminalDisplayText } from './terminal-display.js'

export interface TuiExitSummary {
	readonly conversationId?: string
}

/** A useful shell handoff, never the TUI's buffered internal diagnostics. */
export function formatTuiExitSummary(summary: TuiExitSummary | null): string {
	if (!summary?.conversationId) return ''
	const id = terminalDisplayText(summary.conversationId)
	return `To resume this conversation, run: namzu resume ${id}\n`
}
