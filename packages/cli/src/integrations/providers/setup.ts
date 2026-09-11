import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { resolveNpmInvocation } from '../npm-invocation.js'
import type { DetectedProvider } from './discover.js'

export const SETUP_HARNESSES = [
	{ id: 'codex', label: 'Codex', binary: 'codex', npmPackage: '@openai/codex', provider: 'codex' },
	{
		id: 'claude',
		label: 'Claude Code',
		binary: 'claude',
		npmPackage: '@anthropic-ai/claude-code',
		provider: 'anthropic',
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		binary: 'opencode',
		npmPackage: 'opencode-ai',
		provider: 'zen',
	},
] as const
export type SetupHarness = (typeof SETUP_HARNESSES)[number]
export interface SetupProbe {
	readonly harness: SetupHarness
	readonly installed: boolean
	readonly version: string
	readonly access: string
}

/** Fixed argv, bounded output, owned process group. No credential contents enter diagnostics. */
export function runSetupCommand(
	command: string,
	args: readonly string[],
	options: {
		readonly cwd: string
		readonly signal: AbortSignal
		readonly timeoutMs: number
		readonly onOutput?: (text: string) => void
	},
): Promise<{ code: number | null; output: string; missing: boolean }> {
	options.signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		const invocation = resolveNpmInvocation(command, args)
		const child = spawn(invocation.executable, [...invocation.args], {
			cwd: options.cwd,
			shell: false,
			detached: process.platform !== 'win32',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let output = ''
		let missing = false
		const append = (data: Buffer) => {
			output = (output + data.toString('utf8')).slice(-8000)
			options.onOutput?.(output)
		}
		child.stdout.on('data', append)
		child.stderr.on('data', append)
		let stopped = false
		let stopCompletion: Promise<void> | undefined
		let stopError: Error | undefined
		const stop = () => {
			if (stopped) return
			stopped = true
			try {
				if (process.platform === 'win32' && child.pid) {
					// npm may own package-script children. Terminating only Node
					// leaves those children and their output pipes alive.
					const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
					const pid = child.pid
					stopCompletion = new Promise((resolveStop) => {
						const finishStop = (error: Error | null) => {
							if (error) {
								stopError = new Error(
									'Windows could not confirm that all installer child processes stopped.',
									{ cause: error },
								)
								child.kill('SIGKILL')
								// A surviving descendant can hold these pipes open after
								// npm exits. Release our handles so failure can settle;
								// this does not claim that the descendant was terminated.
								child.stdout.destroy()
								child.stderr.destroy()
							}
							resolveStop()
						}
						try {
							execFile(
								taskkill,
								['/PID', String(pid), '/T', '/F'],
								{
									windowsHide: true,
									timeout: 3000,
									killSignal: 'SIGKILL',
								},
								finishStop,
							)
						} catch (error) {
							finishStop(error instanceof Error ? error : new Error(String(error)))
						}
					})
				} else if (child.pid) process.kill(-child.pid, 'SIGKILL')
				else child.kill('SIGKILL')
			} catch {
				child.kill('SIGKILL')
			}
		}
		const timer = setTimeout(stop, options.timeoutMs)
		options.signal.addEventListener('abort', stop, { once: true })
		let settled = false
		const finish = (code: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			options.signal.removeEventListener('abort', stop)
			// Closing npm's pipes does not prove that taskkill has finished its
			// descendant walk. A stopped operation settles after that bounded job.
			void (stopCompletion ?? Promise.resolve()).then(() => {
				if (stopError) reject(stopError)
				else resolve({ code: stopped ? null : code, output, missing })
			})
		}
		child.on('error', (error) => {
			missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
			append(Buffer.from(error.message))
			finish(null)
		})
		child.on('close', finish)
		child.on('exit', () => {
			if (options.signal.aborted) {
				child.stdout.destroy()
				child.stderr.destroy()
			}
		})
		if (options.signal.aborted) stop()
	})
}

export async function probeHarnesses(
	detected: readonly DetectedProvider[],
	cwd: string,
	signal: AbortSignal,
): Promise<SetupProbe[]> {
	return Promise.all(
		SETUP_HARNESSES.map(async (harness) => {
			const result = await runSetupCommand(harness.binary, ['--version'], {
				cwd,
				signal,
				timeoutMs: 3000,
			})
			const source = detected.find((item) => item.entry.id === harness.provider)?.source
			return {
				harness,
				installed: !result.missing,
				version:
					result.code === 0 ? (result.output.trim().split('\n')[0] ?? '') : 'Version check failed',
				access:
					source?.kind === 'public'
						? 'Public free models · no sign-in required'
						: source
							? `Credential detected · ${source.kind}`
							: 'Not connected · sign in or add an API key',
			}
		}),
	)
}

export function installHarness(
	harness: SetupHarness,
	options: { cwd: string; signal: AbortSignal; onOutput: (text: string) => void },
) {
	// Resolve an exact catalogue entry; callers cannot turn a UI label into arbitrary argv.
	const known = SETUP_HARNESSES.find((entry) => entry.id === harness.id)
	if (!known || known.npmPackage !== harness.npmPackage)
		throw new Error('Unknown installation target')
	return runSetupCommand('npm', ['install', '--global', known.npmPackage], {
		...options,
		timeoutMs: 300_000,
	})
}
