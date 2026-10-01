import { formatResumeShellCommand } from '../resume-shell.js'

export interface TuiExitSummary {
	readonly conversationId?: string
	readonly palId?: string
}

export interface TuiResumeInvocation {
	/** Absolute conversation working directory, independent of the caller's next shell location. */
	readonly cwd?: string
	/** Explicit executable and arguments from the binary entrypoint or embedding host. */
	readonly command?: readonly [string, ...string[]]
	/** Pal chats reopen through their owner, independent of the shell's current folder. */
	readonly palId?: string
}

/** A useful shell handoff, never the TUI's buffered internal diagnostics. */
export function formatTuiExitSummary(
	summary: TuiExitSummary | null,
	invocation: TuiResumeInvocation = {},
	platform: NodeJS.Platform = process.platform,
): string {
	if (!summary?.conversationId) return ''
	const palId = summary.palId ?? invocation.palId
	const args = [
		...(invocation.command ?? ['namzu']),
		...(palId
			? ['pal', 'chat', palId, '--resume', summary.conversationId]
			: ['resume', summary.conversationId]),
	]
	const cwd =
		!palId && invocation.cwd && invocation.cwd !== process.cwd() ? invocation.cwd : undefined
	const command = formatResumeShellCommand(args, { platform, cwd })
	if (platform === 'win32') {
		// Name the shell rather than guessing it from inherited environment.
		return `To resume this conversation, run in PowerShell: ${command}\n`
	}
	return `To resume this conversation, run: ${command}\n`
}
