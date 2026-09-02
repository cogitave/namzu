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

import { spawn } from 'node:child_process'

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

export function runShellEscape(
	command: string,
	options: { readonly cwd: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<ShellEscapeResult> {
	const timeoutMs = options.timeoutMs ?? SHELL_ESCAPE_TIMEOUT_MS
	const startedAt = Date.now()
	return new Promise((resolve) => {
		const child = spawn('/bin/sh', ['-c', command], {
			cwd: options.cwd,
			env: process.env,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let output = ''
		let truncated = false
		let timedOut = false
		let settled = false
		const append = (chunk: Buffer) => {
			if (truncated) return
			output += chunk.toString('utf8')
			if (output.length > SHELL_ESCAPE_MAX_OUTPUT_CHARS) {
				output = output.slice(0, SHELL_ESCAPE_MAX_OUTPUT_CHARS)
				truncated = true
			}
		}
		child.stdout?.on('data', append)
		child.stderr?.on('data', append)
		const killTree = () => {
			if (child.pid !== undefined && process.platform !== 'win32') {
				try {
					process.kill(-child.pid, 'SIGKILL')
					return
				} catch {
					// Group already gone; fall through to the child alone.
				}
			}
			child.kill('SIGKILL')
		}
		const timer = setTimeout(() => {
			timedOut = true
			killTree()
		}, timeoutMs)
		const onAbort = () => killTree()
		options.signal?.addEventListener('abort', onAbort, { once: true })
		const finish = (exitCode: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', onAbort)
			resolve({ output, exitCode, timedOut, truncated, durationMs: Date.now() - startedAt })
		}
		child.on('error', () => finish(null))
		child.on('close', (code) => finish(code))
		child.on('exit', () => {
			if (timedOut || options.signal?.aborted) {
				child.stdout?.destroy()
				child.stderr?.destroy()
			}
		})
	})
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
