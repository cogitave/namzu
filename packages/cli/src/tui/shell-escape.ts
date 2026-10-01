/**
 * `!command` — the operator's own shell command, run without the model.
 *
 * What other coding agents call bash mode: a line that starts with `!` is
 * not a prompt, it is a command the operator wants run right now, with the
 * output in the transcript where the model will see it on the next turn.
 * It runs on the host with the operator's authority, exactly as typing it
 * in another terminal would — so it is not the model's `bash`, it does not
 * pass the authorization gate, and it does not enter the sandbox. That is
 * the point: the operator is not a tool call.
 *
 * Bounded all the same. A command that does not end within the cap is
 * killed with its process group, and output is cut at a size the
 * transcript can hold.
 */

import { execHostShell } from '@namzu/sdk'

export const SHELL_ESCAPE_TIMEOUT_MS = 60_000
export const SHELL_ESCAPE_MAX_OUTPUT_CHARS = 20_000

export interface ShellEscapeResult {
	readonly output: string
	readonly exitCode: number | null
	readonly timedOut: boolean
	readonly truncated: boolean
	readonly durationMs: number
}

/** The command behind a `!` line, or null when the line is not one. */
export function shellEscapeCommand(line: string): string | null {
	if (!line.startsWith('!')) return null
	const command = line.slice(1).trim()
	return command.length > 0 ? command : null
}

export async function runShellEscape(
	command: string,
	options: { readonly cwd: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<ShellEscapeResult> {
	const startedAt = Date.now()
	let output = ''
	let truncated = false
	const append = (data: string) => {
		if (truncated) return
		output += data
		if (output.length > SHELL_ESCAPE_MAX_OUTPUT_CHARS) {
			output = output.slice(0, SHELL_ESCAPE_MAX_OUTPUT_CHARS)
			truncated = true
		}
	}
	let exitCode: number | null = 0
	let timedOut = false
	try {
		await execHostShell(command, {
			cwd: options.cwd,
			env: process.env,
			timeout: options.timeoutMs ?? SHELL_ESCAPE_TIMEOUT_MS,
			maxBuffer: SHELL_ESCAPE_MAX_OUTPUT_CHARS * 4,
			// Keep the existing POSIX interpreter. Windows must use its native
			// platform shell; /bin/sh would either fail or enter another OS.
			shell:
				process.platform === 'win32'
					? { path: undefined, dialect: 'cmd', source: 'platform' }
					: { path: '/bin/sh', dialect: 'sh', source: 'sh' },
			signal: options.signal,
			onOutput: ({ data }) => append(data),
		})
	} catch (error) {
		const failure = error as Error & {
			code?: number | string
			timedOut?: boolean
			stdoutTruncated?: boolean
			stderrTruncated?: boolean
		}
		exitCode = options.signal?.aborted
			? null
			: typeof failure.code === 'number'
				? failure.code
				: null
		timedOut = failure.timedOut === true
		truncated ||= failure.stdoutTruncated === true || failure.stderrTruncated === true
		// A spawn failure otherwise looks like an empty command result.
		if (!output && !timedOut && !options.signal?.aborted) append(failure.message)
	}
	return { output, exitCode, timedOut, truncated, durationMs: Date.now() - startedAt }
}

/**
 * What the model is told on its next turn. The operator ran this with their
 * own hands; the model did not see it happen, and a `!` line that left no
 * trace for the model would be a command the operator has to repeat in
 * prose. Cut to a size a system block can carry.
 */
export function describeShellEscapeForModel(command: string, result: ShellEscapeResult): string {
	const body = result.output.replace(/\n$/u, '')
	const cut =
		body.length > SHELL_ESCAPE_MODEL_CHARS
			? `${body.slice(0, SHELL_ESCAPE_MODEL_CHARS)}\n… (output cut)`
			: body
	return `$ ${command}\n${cut.length > 0 ? `${cut}\n` : ''}(${describeShellEscape(command, result).replace(/^! .* · /u, '')})`
}

export const SHELL_ESCAPE_MODEL_CHARS = 8_000

/** The transcript row for a finished `!` command. */
export function describeShellEscape(command: string, result: ShellEscapeResult): string {
	const state = result.timedOut
		? `killed after ${Math.round((result.durationMs ?? 0) / 1000)}s`
		: result.exitCode === 0
			? 'exit 0'
			: `exit ${result.exitCode ?? '?'}`
	return `! ${command} · ${state}${result.truncated ? ' · output cut' : ''}`
}
