/**
 * How the installers run the supervisor's commands: argv only, never a
 * shell, with a timeout. Injectable, so an installer is tested against a
 * recording fake instead of this machine's service manager.
 */

import { execFile } from 'node:child_process'

export interface CommandResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options?: {
		readonly timeoutMs?: number
		readonly cwd?: string
		readonly env?: NodeJS.ProcessEnv
	},
) => Promise<CommandResult>

export const runCommand: CommandRunner = (command, args, options = {}) =>
	new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{
				timeout: options.timeoutMs ?? 30_000,
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024,
				...(options.cwd ? { cwd: options.cwd } : {}),
				...(options.env ? { env: options.env } : {}),
				encoding: 'buffer',
			},
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0
				resolve({ code, stdout: decode(stdout), stderr: decode(stderr) })
			},
		)
	})

/** Windows tools answer in UTF-16 or the console code page; read both. */
function decode(buffer: Buffer | string): string {
	if (typeof buffer === 'string') return buffer
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
		return buffer.subarray(2).toString('utf16le')
	// UTF-16LE without a BOM: every other byte of ASCII text is zero.
	if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) return buffer.toString('utf16le')
	return buffer.toString('utf8')
}
