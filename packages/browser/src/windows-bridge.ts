import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { WINDOWS_BRIDGE_SCRIPT } from './windows-bridge-script.js'

/**
 * The WSL half of the PowerShell bridge: builds the command line, starts
 * `powershell.exe` through interop, reads its `ready` line, and moves
 * newline-framed CDP messages in and out of its standard streams.
 */

/** What the bridge script is told, as base64 JSON inside the script. */
export interface WindowsBridgeParams {
	/** The browser, as Windows sees it. */
	readonly executable: string
	/** The profile name; the user data directory defaults to `%LOCALAPPDATA%\namzu\browser\profiles\<profile>`. */
	readonly profile: string
	/** A user data directory (Windows path) to use instead of the default. */
	readonly userDataDir?: string
	readonly headless: boolean
	/** Close a browser this bridge started when its stdin closes. */
	readonly closeOnExit: boolean
	/** How long to wait for `DevToolsActivePort` after starting the browser. */
	readonly launchTimeoutMs: number
	/** Only attach to a running browser; never start one. */
	readonly attachOnly?: boolean
}

/** The bridge's `ready` line. */
export interface WindowsBridgeReady {
	readonly type: 'ready'
	/** The profile's user data directory, as Windows sees it. */
	readonly userDataDir: string
	/** The browser's debugging port on Windows' `127.0.0.1`. */
	readonly port: number
	/** `/devtools/browser/<id>`. */
	readonly path: string
	/** Whether this bridge started the browser (else it attached to a running one). */
	readonly launched: boolean
	/** The started browser's Windows process id; 0 when attached. */
	readonly pid: number
	readonly localAppData: string
}

/** A refusal from the bridge script, before `ready`. */
export class WindowsBridgeError extends Error {
	override readonly name = 'WindowsBridgeError'

	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

const PARAMS_PLACEHOLDER = '__NAMZU_BRIDGE_PARAMS__'

/** PowerShell's `-EncodedCommand` form: the script as UTF-16LE, base64. */
export function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64')
}

/** The bridge script with `params` embedded. */
export function bridgeScript(params: WindowsBridgeParams): string {
	const encoded = Buffer.from(JSON.stringify(params), 'utf8').toString('base64')
	return WINDOWS_BRIDGE_SCRIPT.replace(PARAMS_PLACEHOLDER, encoded)
}

/** `powershell.exe`'s arguments for the bridge. */
export function bridgeArguments(params: WindowsBridgeParams): string[] {
	return [
		'-NoLogo',
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		encodePowerShellCommand(bridgeScript(params)),
	]
}

/**
 * Chrome's `DevToolsActivePort` file: the port on the first line, the browser
 * target's path on the second. `undefined` for anything else.
 */
export function parseDevToolsActivePort(
	text: string | undefined,
): { port: number; path: string } | undefined {
	if (text === undefined) return undefined
	const [first, second] = text.split(/\r?\n/)
	const port = Number((first ?? '').trim())
	const path = (second ?? '').trim()
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
	if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) return undefined
	return { port, path }
}

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

/**
 * Cuts a byte stream into lines at `\n` (a trailing `\r` is dropped).
 * Chunks are kept as they arrive and joined once per line, and only the new
 * chunk is scanned, so a multi-megabyte line costs one copy.
 */
export class LineSplitter {
	private pending: Buffer[] = []
	private pendingBytes = 0

	constructor(private readonly onLine: (line: Buffer) => void) {}

	push(chunk: Buffer): void {
		let start = 0
		for (;;) {
			const at = chunk.indexOf(NEWLINE, start)
			if (at === -1) break
			let line: Buffer
			const part = chunk.subarray(start, at)
			if (this.pendingBytes > 0) {
				this.pending.push(part)
				line = Buffer.concat(this.pending, this.pendingBytes + part.length)
				this.pending = []
				this.pendingBytes = 0
			} else {
				line = part
			}
			if (line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN) {
				line = line.subarray(0, line.length - 1)
			}
			this.onLine(line)
			start = at + 1
		}
		if (start < chunk.length) {
			const rest = chunk.subarray(start)
			this.pending.push(rest)
			this.pendingBytes += rest.length
		}
	}

	/** Bytes held for a line not yet ended. */
	get buffered(): number {
		return this.pendingBytes
	}
}

const CONTROL_PREFIX = Buffer.from('@namzu ')
const OPEN_BRACE = 0x7b

export interface StartWindowsBridgeOptions {
	/** `powershell.exe`, as WSL sees it. */
	readonly powershell: string
	readonly params: WindowsBridgeParams
	/** The environment for `powershell.exe`; must carry a working `WSL_INTEROP`. */
	readonly env: NodeJS.ProcessEnv
	/** How long to wait for `ready`. Default: the launch timeout plus 15 s. */
	readonly readyTimeoutMs?: number
	/** For tests: start something other than `powershell.exe`. */
	readonly spawnProcess?: (
		command: string,
		args: readonly string[],
		env: NodeJS.ProcessEnv,
	) => ChildProcessWithoutNullStreams
}

/** A running bridge: one `powershell.exe`, one browser connection. */
export class WindowsCdpBridge {
	private messageListener: ((message: Buffer) => void) | undefined
	private readonly early: Buffer[] = []
	private exitedFlag = false
	/** Resolves when the bridge process has exited. */
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		readonly ready: WindowsBridgeReady,
		exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
		early: Buffer[],
		private readonly stderrTail: string[],
	) {
		this.exited = exited
		this.early.push(...early)
		void exited.then(() => {
			this.exitedFlag = true
		})
	}

	/** The bridge's process id on the Linux side. */
	get pid(): number | undefined {
		return this.child.pid
	}

	get alive(): boolean {
		return !this.exitedFlag
	}

	static async start(options: StartWindowsBridgeOptions): Promise<WindowsCdpBridge> {
		const args = bridgeArguments(options.params)
		const child = options.spawnProcess
			? options.spawnProcess(options.powershell, args, options.env)
			: spawn(options.powershell, args, {
					env: options.env,
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true,
				})
		const stderrTail: string[] = []
		child.stderr.setEncoding('utf8')
		child.stderr.on('data', (text: string) => {
			stderrTail.push(text)
			while (stderrTail.join('').length > 4_000) stderrTail.shift()
		})
		// A write to a bridge that has gone is reported by `exited`, not thrown.
		child.stdin.on('error', () => undefined)
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve) => {
				child.once('close', (code, signal) => resolve({ code, signal }))
				child.once('error', () => resolve({ code: null, signal: null }))
			},
		)

		const holder: { bridge?: WindowsCdpBridge } = {}
		const early: Buffer[] = []
		const readyTimeout = options.readyTimeoutMs ?? options.params.launchTimeoutMs + 15_000
		const ready = await new Promise<WindowsBridgeReady>((resolve, reject) => {
			let settled = false
			const settle = (fn: () => void) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				fn()
			}
			const timer = setTimeout(() => {
				settle(() =>
					reject(
						new WindowsBridgeError(
							'bridge-timeout',
							`powershell.exe did not report within ${readyTimeout} ms.${tail(stderrTail)}`,
						),
					),
				)
			}, readyTimeout)
			const splitter = new LineSplitter((line) => {
				if (line[0] === OPEN_BRACE) {
					if (holder.bridge) holder.bridge.deliver(line)
					else early.push(line)
					return
				}
				if (!startsWith(line, CONTROL_PREFIX)) return
				let control: Record<string, unknown>
				try {
					control = JSON.parse(line.subarray(CONTROL_PREFIX.length).toString('utf8'))
				} catch {
					return
				}
				if (control.type === 'ready')
					settle(() => resolve(control as unknown as WindowsBridgeReady))
				else if (control.type === 'error') {
					settle(() =>
						reject(
							new WindowsBridgeError(
								String(control.code ?? 'bridge-error'),
								String(control.message ?? 'The bridge failed.'),
							),
						),
					)
				}
			})
			child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk))
			child.once('error', (error) => {
				settle(() =>
					reject(
						new WindowsBridgeError(
							'spawn-failed',
							`Could not start ${options.powershell}: ${error.message}`,
						),
					),
				)
			})
			void exited.then(({ code }) => {
				settle(() =>
					reject(
						new WindowsBridgeError(
							'bridge-exited',
							`powershell.exe exited (code ${code}) before the browser was ready.${tail(stderrTail)}`,
						),
					),
				)
			})
		}).catch((error: unknown) => {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
			throw error
		})
		holder.bridge = new WindowsCdpBridge(child, ready, exited, early, stderrTail)
		return holder.bridge
	}

	private deliver(line: Buffer): void {
		if (this.messageListener) this.messageListener(line)
		else this.early.push(line)
	}

	/** Receive every CDP message from the browser, one per call, as UTF-8 JSON. */
	onMessage(listener: (message: Buffer) => void): void {
		this.messageListener = listener
		const held = this.early.splice(0)
		for (const line of held) listener(line)
	}

	/**
	 * Send one CDP message. A message with a raw newline (legal JSON
	 * whitespace, never produced by Playwright) is re-serialised so it stays
	 * one line.
	 */
	send(message: string | Buffer): boolean {
		if (!this.alive || this.child.stdin.destroyed) return false
		let text = typeof message === 'string' ? message : message.toString('utf8')
		if (text.includes('\n') || text.includes('\r')) text = JSON.stringify(JSON.parse(text))
		this.child.stdin.write(`${text}\n`)
		return true
	}

	/** Leave a browser this bridge started running when it exits. */
	keepBrowser(): void {
		if (this.alive && !this.child.stdin.destroyed) this.child.stdin.write('@namzu keep\n')
	}

	/**
	 * Close stdin and wait for the bridge to exit (it closes a browser it
	 * started unless told to keep it). Killed after `timeoutMs`.
	 */
	async stop(timeoutMs = 15_000): Promise<void> {
		if (!this.alive) return
		this.child.stdin.end()
		let timer: NodeJS.Timeout | undefined
		const timedOut = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), timeoutMs)
		})
		const outcome = await Promise.race([this.exited, timedOut])
		clearTimeout(timer)
		if (outcome === 'timeout') {
			this.child.kill('SIGKILL')
			await this.exited
		}
	}

	/** The end of what `powershell.exe` wrote to stderr. */
	get stderr(): string {
		return this.stderrTail.join('')
	}
}

function startsWith(line: Buffer, prefix: Buffer): boolean {
	return line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix)
}

function tail(parts: readonly string[]): string {
	const text = parts.join('').trim()
	if (text.length === 0) return ''
	return ` PowerShell said: ${text.length > 600 ? `…${text.slice(-600)}` : text}`
}
