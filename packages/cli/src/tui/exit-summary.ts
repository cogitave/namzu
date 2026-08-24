import { terminalDisplayText } from './terminal-display.js'

export interface TuiExitSummary {
	readonly conversationId?: string
}

/** A useful shell handoff, never the TUI's buffered internal diagnostics. */
export function formatTuiExitSummary(summary: TuiExitSummary | null): string {
	if (!summary?.conversationId) return ''
	return `Conversation ${terminalDisplayText(summary.conversationId)} · restart namzu, then run /resume\n`
}
