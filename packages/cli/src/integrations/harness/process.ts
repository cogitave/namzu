import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export interface NativeHarnessCommand {
	readonly executable: string
	readonly args: readonly string[]
	readonly env?: NodeJS.ProcessEnv
}

export interface HarnessProcess {
	write(frame: unknown): Promise<void>
	/** Resolves only after the process, pipes and already-received frames close. */
	readonly closed: Promise<void>
	/** A failed owned stop keeps this handle retryable. */
	close(): Promise<{ readonly stopped: true }>
}

export interface HarnessProcessOptions {
	readonly cwd: string
	readonly onFrame: (frame: unknown) => Promise<void> | void
	readonly onClosed: (error?: Error) => Promise<void> | void
	readonly signal?: AbortSignal
}

const CLOSE_GRACE_MS = 3000
const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Exact native argv and process ownership, shared by vendor wire adapters. */
export function startHarnessProcess(
	command: NativeHarnessCommand,
	options: HarnessProcessOptions,
): HarnessProcess {
	options.signal?.throwIfAborted()
	const child = spawn(command.executable, [...command.args], {
		cwd: options.cwd,
		env: command.env ?? process.env,
		shell: false,
		detached: process.platform !== 'win32',
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	const decoder = new StringDecoder('utf8')
	let buffer = ''
	let receivedBytes = 0
	let tail: Promise<void> = Promise.resolve()
	let failure: Error | undefined
	let exited = false
	let ended = false
	let closing = false
	let closeOperation: Promise<{ readonly stopped: true }> | undefined
	let complete!: () => void
	const closed = new Promise<void>((resolve) => {
		complete = resolve
	})
	let stopped!: () => void
	const processClosed = new Promise<void>((resolve) => {
		stopped = resolve
	})
	const forceStop = async () => {
		if (ended) return
		if (!child.pid) throw new Error('Harness process has no owned PID to stop.')
		if (process.platform === 'win32') {
			// Never target a reused PID after its root process has already exited.
			if (exited) throw new Error('Harness descendants could not be confirmed stopped.')
			await new Promise<void>((resolve, reject) => {
				execFile(
					join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
					['/PID', String(child.pid), '/T', '/F'],
					{ windowsHide: true, timeout: 3000, killSignal: 'SIGKILL' },
					(error) =>
						error
							? reject(new Error('Owned harness tree stop failed.', { cause: error }))
							: resolve(),
				)
			})
		} else {
			try {
				process.kill(-child.pid, 'SIGKILL')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
			}
		}
	}
	const close = () => {
		if (closeOperation) return closeOperation
		closing = true
		closeOperation = (async () => {
			child.stdin.end()
			let grace!: () => void
			const graceExpired = new Promise<void>((resolve) => {
				grace = resolve
			})
			const timer = setTimeout(grace, CLOSE_GRACE_MS)
			try {
				await Promise.race([processClosed, graceExpired])
				if (!ended) {
					await forceStop()
					let confirmationTimer!: ReturnType<typeof setTimeout>
					try {
						await Promise.race([
							processClosed,
							new Promise<void>((_, reject) => {
								confirmationTimer = setTimeout(
									() => reject(new Error('Harness tree closure could not be confirmed.')),
									CLOSE_GRACE_MS,
								)
							}),
						])
					} finally {
						clearTimeout(confirmationTimer)
					}
				}
				await closed
				return { stopped: true as const }
			} finally {
				clearTimeout(timer)
			}
		})().catch((error) => {
			closeOperation = undefined
			throw error
		})
		return closeOperation
	}
	const fail = (error: Error) => {
		failure ??= error
		void close().catch(() => undefined)
	}
	const frame = (line: string) => {
		if (failure || !line.trim()) return
		let value: unknown
		try {
			value = JSON.parse(line)
		} catch {
			fail(new Error('Harness emitted an invalid JSON frame.'))
			return
		}
		tail = tail
			.then(() => {
				if (!failure) return options.onFrame(value)
			})
			.catch((error) => {
				fail(error instanceof Error ? error : new Error('Harness frame handling failed.'))
			})
	}
	const consume = (text: string) => {
		buffer += text
		let newline = buffer.indexOf('\n')
		while (newline !== -1) {
			const line = buffer.slice(0, newline)
			buffer = buffer.slice(newline + 1)
			if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
				fail(new Error('Harness frame exceeds the supported transport size.'))
				return
			}
			frame(line)
			newline = buffer.indexOf('\n')
		}
		receivedBytes = Buffer.byteLength(buffer)
		if (receivedBytes > MAX_FRAME_BYTES) {
			buffer = ''
			fail(new Error('Harness frame exceeds the supported transport size.'))
		}
	}
	child.stdout.on('data', (data: Buffer) => consume(decoder.write(data)))
	// Stderr is diagnostic-only; native secrets and raw diagnostics never enter public events.
	child.stderr.on('data', () => undefined)
	child.stdin.on('error', () => undefined)
	child.on('error', () => fail(new Error('Harness native process could not start.')))
	child.once('exit', () => {
		exited = true
	})
	child.once('close', (code) => {
		consume(decoder.end())
		if (buffer.trim()) frame(buffer)
		buffer = ''
		ended = true
		stopped()
		options.signal?.removeEventListener('abort', abort)
		void tail
			.then(() =>
				options.onClosed(
					failure ?? (!closing ? new Error(`Harness exited (${code ?? 'signal'}).`) : undefined),
				),
			)
			.catch(() => undefined)
			.finally(complete)
	})
	const abort = () => {
		void close().catch(() => undefined)
	}
	options.signal?.addEventListener('abort', abort, { once: true })
	if (options.signal?.aborted) abort()
	return {
		closed,
		close,
		async write(value) {
			if (closing || ended) throw new Error('Harness transport is closed.')
			const line = `${JSON.stringify(value)}\n`
			if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
				return Promise.reject(new Error('Harness request exceeds the supported transport size.'))
			return new Promise<void>((resolve, reject) => {
				child.stdin.write(line, 'utf8', (error) => (error ? reject(error) : resolve()))
			})
		},
	}
}
