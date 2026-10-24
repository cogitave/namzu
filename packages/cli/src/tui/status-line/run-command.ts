/**
 * Runs the status line command: the payload on stdin, the host shell, the
 * working directory, `COLUMNS` set to the terminal width. Exit `0` with
 * output is a line; anything else (a non-zero exit, a spawn failure, a
 * timeout, an abort) is no line. stderr is ignored, as it must not reach a
 * screen that is being drawn.
 *
 * A status line gets the hook default deadline, ten minutes,
 * and relies on the next run aborting a stuck one; so do we.
 */

import { type ChildProcess, spawn } from 'node:child_process'

import { sanitiseStatusLineOutput } from './output.js'

export const STATUS_LINE_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 64 * 1024

export interface RunStatusLineOptions {
	readonly command: string
	readonly payload: unknown
	readonly cwd: string
	readonly columns: number
	readonly signal: AbortSignal
	readonly timeoutMs?: number
	readonly env?: NodeJS.ProcessEnv
	readonly spawnImpl?: typeof spawn
}

export function runStatusLineCommand(options: RunStatusLineOptions): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (options.signal.aborted) return resolve(undefined)
		const run = options.spawnImpl ?? spawn
		let child: ChildProcess
		try {
			child = run(options.command, {
				shell: true,
				cwd: options.cwd,
				env: {
					...(options.env ?? process.env),
					COLUMNS: String(options.columns),
				},
				stdio: ['pipe', 'pipe', 'ignore'],
				windowsHide: true,
				detached: process.platform !== 'win32',
			})
		} catch {
			return resolve(undefined)
		}
		let out = ''
		let settled = false
		const finish = (value: string | undefined): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			options.signal.removeEventListener('abort', onAbort)
			resolve(value)
		}
		const kill = (): void => {
			try {
				if (process.platform !== 'win32' && child.pid !== undefined)
					process.kill(-child.pid, 'SIGKILL')
				else child.kill('SIGKILL')
			} catch {
				// Already gone.
			}
		}
		const onAbort = (): void => {
			kill()
			finish(undefined)
		}
		const timer = setTimeout(onAbort, options.timeoutMs ?? STATUS_LINE_TIMEOUT_MS)
		options.signal.addEventListener('abort', onAbort, { once: true })
		child.stdout?.setEncoding('utf8')
		child.stdout?.on('data', (chunk: string) => {
			if (out.length < MAX_OUTPUT_BYTES) out += chunk
		})
		child.stdin?.on('error', () => undefined)
		child.on('error', () => finish(undefined))
		child.on('close', (code) => finish(code === 0 ? sanitiseStatusLineOutput(out) : undefined))
		child.stdin?.end(JSON.stringify(options.payload))
	})
}
