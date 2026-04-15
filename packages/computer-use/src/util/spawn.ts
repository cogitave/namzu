import { type ChildProcess, spawn } from 'node:child_process'

export interface SpawnResult {
	readonly exitCode: number
	readonly stdout: Buffer
	readonly stderr: string
	readonly timedOut: boolean
	readonly signal: NodeJS.Signals | null
}

export interface SpawnOptions {
	readonly timeoutMs?: number
	readonly stdin?: string | Buffer
	readonly env?: NodeJS.ProcessEnv
	readonly cwd?: string
}

export class SpawnError extends Error {
	constructor(
		message: string,
		readonly result: SpawnResult,
		readonly command: string,
		readonly args: readonly string[],
	) {
		super(message)
		this.name = 'SpawnError'
	}
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Argv-array spawn wrapper. No shell interpretation — user-controlled strings
 * pass through as discrete `args` entries. stdout is buffered as Buffer to
 * preserve binary output (screenshots). stderr is string-decoded for error
 * diagnostics. Times out with SIGKILL.
 */
export function runCommand(
	command: string,
	args: readonly string[],
	options: SpawnOptions = {},
): Promise<SpawnResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	return new Promise((resolve, reject) => {
		let child: ChildProcess
		try {
			child = spawn(command, args as string[], {
				env: options.env,
				cwd: options.cwd,
				shell: false,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)))
			return
		}

		const stdoutChunks: Buffer[] = []
		const stderrChunks: string[] = []
		let timedOut = false

		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, timeoutMs)

		child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
		child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')))

		child.on('error', (err) => {
			clearTimeout(timer)
			reject(err)
		})

		child.on('close', (code, signal) => {
			clearTimeout(timer)
			resolve({
				exitCode: code ?? -1,
				stdout: Buffer.concat(stdoutChunks),
				stderr: stderrChunks.join(''),
				timedOut,
				signal,
			})
		})

		if (options.stdin !== undefined && child.stdin) {
			child.stdin.end(options.stdin)
		} else {
			child.stdin?.end()
		}
	})
}

/**
 * Convenience: run a command and throw SpawnError on non-zero exit. Returns
 * the successful result directly. Useful when the caller doesn't want to
 * inspect exit codes manually.
 */
export async function runCommandOrThrow(
	command: string,
	args: readonly string[],
	options: SpawnOptions = {},
): Promise<SpawnResult> {
	const result = await runCommand(command, args, options)
	if (result.timedOut) {
		throw new SpawnError(
			`${command} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
			result,
			command,
			args,
		)
	}
	if (result.exitCode !== 0) {
		throw new SpawnError(
			`${command} exited with code ${result.exitCode}: ${result.stderr.trim() || '<no stderr>'}`,
			result,
			command,
			args,
		)
	}
	return result
}

/**
 * Probe for presence of an executable on PATH. Uses `/usr/bin/env -- name --help`
 * or plain `which`. Returns true on success, false otherwise. Never throws.
 */
export async function hasExecutable(name: string): Promise<boolean> {
	try {
		const which = process.platform === 'win32' ? 'where' : 'which'
		const result = await runCommand(which, [name], { timeoutMs: 3_000 })
		return result.exitCode === 0 && result.stdout.length > 0
	} catch {
		return false
	}
}
