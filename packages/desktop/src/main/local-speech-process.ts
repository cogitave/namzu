import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { join } from 'node:path'

export class LocalSpeechInstallShutdownError extends Error {
	readonly code = 'LOCAL_SPEECH_INSTALL_SHUTDOWN'
	constructor() {
		super(
			'The owned local speech installer could not be stopped safely. Close the application again to retry.',
		)
	}
}
interface OwnedCommand {
	child: ChildProcess
	closed: Promise<void>
	didClose: boolean
	stopping?: Promise<void>
}
export interface LocalSpeechProcessOptions {
	/** Deterministic test seams; production always uses the native platform and executable. */
	platform?: NodeJS.Platform
	spawn?: typeof spawn
	execFile?: typeof execFile
	killGroup?: (pid: number, signal: NodeJS.Signals) => void
}

/** Keeps process ownership through failed shutdown and confirms closure before file rollback. */
export class LocalSpeechInstallerProcesses {
	private readonly commands = new Set<OwnedCommand>()
	private closing = false
	constructor(private readonly options: LocalSpeechProcessOptions = {}) {}
	readonly run = (
		program: string,
		args: string[],
		options: { cwd: string; signal?: AbortSignal },
	): Promise<string> => {
		if (this.closing || options.signal?.aborted)
			return Promise.reject(new Error('Local speech installation was cancelled.'))
		const platform = this.options.platform ?? process.platform
		const child = (this.options.spawn ?? spawn)(program, args, {
			cwd: options.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			// Unix grandchildren inherit this dedicated process group; no unrelated process joins it.
			detached: platform !== 'win32',
			env: {
				...process.env,
				PIP_CONFIG_FILE: platform === 'win32' ? 'NUL' : '/dev/null',
				PIP_DISABLE_PIP_VERSION_CHECK: '1',
				PYTHONNOUSERSITE: '1',
			},
		})
		const command: OwnedCommand = { child, didClose: false, closed: Promise.resolve() }
		command.closed = new Promise<void>((resolve) =>
			child.once('close', () => {
				command.didClose = true
				this.commands.delete(command)
				resolve()
			}),
		)
		this.commands.add(command)
		return new Promise((accept, reject) => {
			let output = ''
			let failedToStart = false
			let aborted = false
			let code: number | null = null
			let finished = false
			let stop: Promise<void> | undefined
			const complete = () => {
				if (!command.didClose || stop || finished) return
				finished = true
				options.signal?.removeEventListener('abort', abort)
				if (aborted) reject(new Error('Local speech installation was cancelled.'))
				else if (failedToStart) reject(new Error('Local speech installer could not start.'))
				else if (code !== 0) reject(new Error('Local speech installation failed.'))
				else accept(output)
			}
			const abort = () => {
				if (finished || aborted) return
				aborted = true
				stop = this.stop(command)
				void stop.then(
					() => {
						stop = undefined
						complete()
					},
					(error) => {
						finished = true
						options.signal?.removeEventListener('abort', abort)
						// The command stays owned for close() retry. Rollback must refuse this failure.
						reject(error)
					},
				)
			}
			child.stdout?.on('data', (chunk: Buffer) => {
				if (output.length < 512_000)
					output += chunk.toString('utf8').slice(0, 512_000 - output.length)
			})
			child.stderr?.resume()
			child.once('error', () => {
				failedToStart = true
			})
			child.once('close', (exitCode) => {
				code = exitCode
				complete()
			})
			options.signal?.addEventListener('abort', abort, { once: true })
			if (options.signal?.aborted) abort()
		})
	}
	private stop(command: OwnedCommand): Promise<void> {
		if (command.didClose) return Promise.resolve()
		if (command.stopping) return command.stopping
		const child = command.child
		const stopping = (async () => {
			// Never target an exited parent's reusable PID while descendants retain its handles.
			if (!child.pid || child.exitCode !== null || child.signalCode !== null)
				throw new LocalSpeechInstallShutdownError()
			if ((this.options.platform ?? process.platform) === 'win32') {
				const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
				await new Promise<void>((resolve, reject) => {
					;(this.options.execFile ?? execFile)(
						taskkill,
						['/pid', String(child.pid), '/t', '/f'],
						{ windowsHide: true },
						(error) => (error ? reject(new LocalSpeechInstallShutdownError()) : resolve()),
					)
				})
			} else {
				try {
					;(this.options.killGroup ?? process.kill)(-child.pid, 'SIGKILL')
				} catch {
					throw new LocalSpeechInstallShutdownError()
				}
			}
			await command.closed
		})()
		command.stopping = stopping.catch((error) => {
			command.stopping = undefined
			throw error
		})
		return command.stopping
	}
	async close(): Promise<void> {
		this.closing = true
		const results = await Promise.allSettled(
			[...this.commands].map((command) => this.stop(command)),
		)
		for (const result of results) if (result.status === 'rejected') throw result.reason
	}
}
