import { terminalDisplayText } from './terminal-display.js'

export interface TuiExitSummary {
	readonly conversationId?: string
}

export interface TuiResumeInvocation {
	/** Absolute conversation working directory, independent of the caller's next shell location. */
	readonly cwd?: string
	/** Explicit executable and arguments from the binary entrypoint or embedding host. */
	readonly command?: readonly [string, ...string[]]
}

function shellWord(source: string): string {
	const value = terminalDisplayText(source)
	if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value
	return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** A useful shell handoff, never the TUI's buffered internal diagnostics. */
export function formatTuiExitSummary(
	summary: TuiExitSummary | null,
	invocation: TuiResumeInvocation = {},
): string {
	if (!summary?.conversationId) return ''
	const command = [...(invocation.command ?? ['namzu']), 'resume', summary.conversationId]
		.map(shellWord)
		.join(' ')
	const directory = invocation.cwd ? `cd ${shellWord(invocation.cwd)} && ` : ''
	return `To resume this conversation, run: ${directory}${command}\n`
}
