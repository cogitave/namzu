import { terminalDisplayText } from './tui/terminal-display.js'

/** A terminal-safe argument for a POSIX shell. */
function shellWord(source: string): string {
	const value = terminalDisplayText(source)
	if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value
	return `'${value.replace(/'/g, `'"'"'`)}'`
}

function powershellWord(source: string): string {
	return `'${terminalDisplayText(source).replace(/'/g, "''")}'`
}

/** Share executable quoting and directory guards across conversation handoffs. */
export function formatResumeShellCommand(
	args: readonly string[],
	options: {
		readonly platform: NodeJS.Platform
		readonly cwd?: string
		/** Existing callers may retain their established POSIX quoting style. */
		readonly quotePosix?: (source: string) => string
	},
): string {
	if (options.platform === 'win32') {
		const command = `& ${args.map(powershellWord).join(' ')}`
		// Windows PowerShell 5.1 lacks &&; resume only after Set-Location succeeds.
		return options.cwd
			? `Set-Location -LiteralPath ${powershellWord(options.cwd)}; if ($?) { ${command} }`
			: command
	}
	const quote = options.quotePosix ?? shellWord
	const command = args.map(quote).join(' ')
	return `${options.cwd ? `cd ${quote(options.cwd)} && ` : ''}${command}`
}
