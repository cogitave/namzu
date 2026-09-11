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

function powershellWord(source: string): string {
	return `'${terminalDisplayText(source).replace(/'/g, "''")}'`
}

/** A useful shell handoff, never the TUI's buffered internal diagnostics. */
export function formatTuiExitSummary(
	summary: TuiExitSummary | null,
	invocation: TuiResumeInvocation = {},
	platform: NodeJS.Platform = process.platform,
): string {
	if (!summary?.conversationId) return ''
	const args = [...(invocation.command ?? ['namzu']), 'resume', summary.conversationId]
	const cwd = invocation.cwd && invocation.cwd !== process.cwd() ? invocation.cwd : undefined
	if (platform === 'win32') {
		const command = `& ${args.map(powershellWord).join(' ')}`
		// Name the shell rather than guessing it from inherited environment.
		// Windows PowerShell 5.1 lacks &&; resume only after Set-Location succeeds.
		const handoff = cwd
			? `Set-Location -LiteralPath ${powershellWord(cwd)}; if ($?) { ${command} }`
			: command
		return `To resume this conversation, run in PowerShell: ${handoff}\n`
	}
	const command = args.map(shellWord).join(' ')
	const directory = cwd ? `cd ${shellWord(cwd)} && ` : ''
	return `To resume this conversation, run: ${directory}${command}\n`
}
