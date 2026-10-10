import { formatResumeShellCommand } from '../resume-shell.js'

export interface TuiExitSummary {
	readonly conversationId?: string
	readonly palId?: string
}

export interface TuiResumeInvocation {
	/** Absolute conversation working directory, independent of the caller's next shell location. */
	readonly cwd?: string
	/**
	 * Executable and arguments from the binary entrypoint or embedding host. Only
	 * the public command (`namzu`, `namzu.cmd`) is printed; a launch through
	 * `node <script>` is shown as `namzu`, because a person types the product
	 * command, never an interpreter or a build path.
	 */
	readonly command?: readonly [string, ...string[]]
	/** Pal chats reopen through their owner, independent of the shell's current folder. */
	readonly palId?: string
}

/** The command a person types: a lone executable name, never `node` plus a script path. */
function publicCommand(command: TuiResumeInvocation['command']): readonly [string, ...string[]] {
	return command && command.length === 1 ? command : ['namzu']
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
		...publicCommand(invocation.command),
		...(palId
			? ['pal', 'chat', palId, '--resume', summary.conversationId]
			: ['resume', summary.conversationId]),
	]
	const cwd =
		!palId && invocation.cwd && invocation.cwd !== process.cwd() ? invocation.cwd : undefined
	const command = formatResumeShellCommand(args, { platform, cwd })
	if (platform === 'win32') {
		// Name the shell rather than guessing it from inherited environment.
		return `To resume this conversation, run in PowerShell:\n${command}\n`
	}
	return `To resume this conversation, run:\n${command}\n`
}
