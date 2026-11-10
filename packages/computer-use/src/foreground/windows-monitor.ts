import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type {
	EditTextRequest,
	EditTextResult,
	ForegroundMonitor,
	MenuCommandRequest,
	MenuCommandResult,
	MonitorBurstEnd,
	MonitorState,
	SelectItemRequest,
	SelectItemResult,
} from './types.js'
import { WINDOWS_HELPER_SCRIPT } from './windows-helper-script.js'

/** The ends of a started helper; the real one is a child process. */
export interface HelperProcess {
	write(line: string): void
	onLine(handler: (line: string) => void): void
	/** `info` is absent where the process cannot say how it ended. */
	onExit(handler: (info?: HelperExit) => void): void
	kill(): void
}

/** How the helper process ended. */
export interface HelperExit {
	readonly code?: number | null
	readonly signal?: string | null
	/** The tail of what it wrote to its error stream (about 2 KB). */
	readonly stderr?: string
	/** The process could not be started at all. */
	readonly spawnError?: Error
}

/** Most of the helper's error stream that is kept. */
const STDERR_KEEP = 2_048
/** Longest cause line put in a reason. */
const CAUSE_MAX = 200

function xmlText(text: string): string {
	return text
		.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
}

/**
 * The last non-empty line of what the helper wrote to its error stream, or
 * undefined. PowerShell wraps non-interactive output in a CLIXML envelope; its
 * progress records ("Preparing modules for first use") are noise, its error
 * records are the cause.
 */
export function stderrCause(stderr: string | undefined): string | undefined {
	if (!stderr) return undefined
	let text = stderr
	if (text.includes('CLIXML') || /<Objs[\s>]/.test(text)) {
		const errors: string[] = []
		for (const match of text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g))
			errors.push(xmlText(match[1] ?? ''))
		text = `${text
			.replace(/#< CLIXML/g, '')
			.replace(/<Objs[\s\S]*?<\/Objs>/g, '')
			.replace(/<Objs[\s\S]*$/, '')}\n${errors.join('')}`
	}
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	const last = lines[lines.length - 1]
	if (!last) return undefined
	return last.length > CAUSE_MAX ? `${last.slice(0, CAUSE_MAX - 1)}…` : last
}

/** Why the helper is gone, in words the model can pass on. */
export function describeHelperExit(info: HelperExit | undefined, greeted: boolean): string {
	if (!info) return 'the Windows helper exited'
	if (info.spawnError) return `could not start Windows PowerShell (${info.spawnError.message})`
	const how =
		info.code !== null && info.code !== undefined
			? `exit code ${info.code}`
			: info.signal
				? `signal ${info.signal}`
				: undefined
	const cause = stderrCause(info.stderr)
	return `${greeted ? 'the Windows helper stopped' : 'the Windows helper stopped while starting'}${how ? ` (${how})` : ''}${cause ? `: ${cause}` : ''}`
}

export interface WindowsMonitorOptions {
	/** Windows PowerShell, as this process starts it. */
	readonly powershell: string
	readonly env?: NodeJS.ProcessEnv
	/** Waiting for the first answer (compiling the helper), ms. Default 60 000. */
	readonly startTimeoutMs?: number
	/** Waiting for each later answer, ms. Default 10 000. */
	readonly requestTimeoutMs?: number
	/** How Windows names a path this process knows (the lease file). Default: unchanged. */
	readonly toWindowsPath?: (path: string) => string
	/** For tests. */
	readonly spawnHelper?: (script: string) => HelperProcess
}

interface Reply {
	/** Echo of the request's id; the first greeting has none. */
	readonly id?: number
	readonly ok: boolean
	readonly r?: unknown
	readonly error?: string
	readonly hooks?: boolean
	readonly hookError?: string
	/** PowerShell's language mode, sent when the helper could not compile its hook library. */
	readonly languageMode?: string
}

/**
 * What PowerShell is started with: a bootstrap that reads the helper script
 * from the first line of its input (UTF-8, base64) and runs it, so the script
 * can grow past the 32 767 characters a command line allows. The line protocol
 * follows on the same stream.
 */
export const HELPER_BOOTSTRAP =
	'$s=[Console]::In.ReadLine();Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))'

/** The bootstrap as PowerShell's `-EncodedCommand` takes it. */
export function encodeHelperCommand(script: string = HELPER_BOOTSTRAP): string {
	return Buffer.from(script, 'utf16le').toString('base64')
}

/** The first line written to a helper started with {@link HELPER_BOOTSTRAP}. */
export function helperScriptLine(script: string = WINDOWS_HELPER_SCRIPT): string {
	return Buffer.from(script, 'utf8').toString('base64')
}

function spawnPowerShell(options: WindowsMonitorOptions): HelperProcess {
	const child = spawn(
		options.powershell,
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			encodeHelperCommand(),
		],
		{ env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
	)
	// Only the tail is kept, and the stream is always drained so a chatty helper cannot block.
	let stderr = ''
	child.stderr.setEncoding('utf8')
	child.stderr.on('data', (chunk: string) => {
		stderr = (stderr + chunk).slice(-STDERR_KEEP)
	})
	child.stderr.on('error', () => undefined)
	// Without a listener a helper that exits first turns a write into an uncaught error.
	child.stdin.on('error', () => undefined)
	child.stdin.write(`${helperScriptLine()}\n`)
	return {
		write: (line) => {
			child.stdin.write(`${line}\n`)
		},
		onLine: (handler) => createInterface({ input: child.stdout }).on('line', handler),
		onExit: (handler) => {
			let done = false
			const finish = (info: HelperExit) => {
				if (done) return
				done = true
				handler(info)
			}
			// `close` follows the end of the error stream, so its tail is complete.
			child.once('close', (code, signal) => finish({ code, signal, stderr }))
			child.once('error', (spawnError) => finish({ spawnError, stderr }))
		},
		kill: () => {
			try {
				// Closing stdin lets the helper put back what a burst moved before it exits.
				child.stdin.end()
			} catch {
				// Already closed.
			}
			setTimeout(() => child.kill(), 3_000).unref()
		},
	}
}

/**
 * A {@link ForegroundMonitor} backed by the long-lived PowerShell helper.
 * One poll answers in well under a millisecond once it runs; starting it
 * compiles a small hook library and takes about half a second warm.
 */
export class WindowsInputMonitor implements ForegroundMonitor {
	private proc: HelperProcess | undefined
	private nextId = 1
	private waiting: Array<{
		id: number
		resolve: (reply: Reply) => void
		timer: ReturnType<typeof setTimeout>
	}> = []
	private exited = false
	private exitReason: string | undefined
	/** The helper has sent its first line. */
	private greeted = false

	/** The helper process is started and has not ended. */
	get running(): boolean {
		return this.proc !== undefined && !this.exited
	}

	constructor(private readonly options: WindowsMonitorOptions) {}

	async start(): Promise<void> {
		if (this.proc) return
		const proc = (this.options.spawnHelper ?? (() => spawnPowerShell(this.options)))(
			WINDOWS_HELPER_SCRIPT,
		)
		this.proc = proc
		proc.onLine((line) => this.onLine(line))
		proc.onExit((info) => {
			this.exited = true
			const reason = describeHelperExit(info, this.greeted)
			if (info) this.exitReason = reason
			for (const waiter of this.waiting.splice(0)) {
				clearTimeout(waiter.timer)
				waiter.resolve({ ok: false, error: reason })
			}
		})
		const hello = await this.expect(this.options.startTimeoutMs ?? 60_000)
		if (!hello.ok || hello.hooks !== true) {
			await this.dispose()
			const why = hello.hookError || hello.error || 'the keyboard and mouse hooks did not start'
			throw new Error(
				hello.languageMode && hello.languageMode !== 'FullLanguage'
					? `${why} (PowerShell language mode: ${hello.languageMode})`
					: why,
			)
		}
	}

	state(query: { readonly pid?: number } = {}): Promise<MonitorState> {
		return this.call<MonitorState>({
			cmd: 'state',
			...(query.pid !== undefined ? { pid: query.pid } : {}),
		})
	}

	begin(args: {
		readonly leasePath: string
		readonly token: string
		readonly raise?: string
		readonly idleMs?: number
	}): Promise<MonitorState & { readonly raised?: boolean; readonly refused?: boolean }> {
		return this.call<MonitorState & { readonly raised?: boolean; readonly refused?: boolean }>({
			cmd: 'begin',
			lease: this.winPath(args.leasePath),
			token: args.token,
			...(args.raise !== undefined ? { raise: args.raise } : {}),
			...(args.idleMs !== undefined ? { idleMs: args.idleMs } : {}),
		})
	}

	end(args: {
		readonly restore: boolean
		readonly keepCursor?: boolean
	}): Promise<MonitorBurstEnd> {
		return this.call<MonitorBurstEnd>({
			cmd: 'end',
			restore: args.restore,
			keepCursor: args.keepCursor === true,
		})
	}

	editText(request: EditTextRequest): Promise<EditTextResult> {
		return this.call<EditTextResult>({
			cmd: 'edit',
			hwnd: request.hwnd,
			op: request.op,
			pick: request.pick,
			...(request.text !== undefined ? { text: request.text } : {}),
			...(request.at ? { x: Math.round(request.at.x), y: Math.round(request.at.y) } : {}),
		})
	}

	menuCommand(request: MenuCommandRequest): Promise<MenuCommandResult> {
		return this.call<MenuCommandResult>({
			cmd: 'menu',
			hwnd: request.hwnd,
			accel: request.accelerator,
		})
	}

	selectItem(request: SelectItemRequest): Promise<SelectItemResult> {
		return this.call<SelectItemResult>({
			cmd: 'select',
			hwnd: request.hwnd,
			role: request.role,
			name: request.name,
			...(request.automationId ? { autoId: request.automationId } : {}),
			...(request.bounds
				? {
						x: Math.round(request.bounds.x),
						y: Math.round(request.bounds.y),
						w: Math.round(request.bounds.width),
						h: Math.round(request.bounds.height),
					}
				: {}),
		})
	}

	async release(args: {
		readonly leasePath: string
		readonly token: string
	}): Promise<void> {
		await this.call({
			cmd: 'release',
			lease: this.winPath(args.leasePath),
			token: args.token,
		})
	}

	async dispose(): Promise<void> {
		const proc = this.proc
		this.proc = undefined
		if (!proc) return
		for (const waiter of this.waiting.splice(0)) {
			clearTimeout(waiter.timer)
			waiter.resolve({ ok: false, error: 'the Windows helper was stopped' })
		}
		proc.kill()
	}

	private winPath(path: string): string {
		return this.options.toWindowsPath ? this.options.toWindowsPath(path) : path
	}

	private onLine(line: string): void {
		let reply: Reply
		try {
			reply = JSON.parse(line) as Reply
		} catch {
			// Cannot tell whose it was: the oldest request is the likeliest.
			const waiter = this.waiting.shift()
			if (!waiter) return
			clearTimeout(waiter.timer)
			waiter.resolve({
				ok: false,
				error: `unreadable helper reply: ${line.slice(0, 120)}`,
			})
			return
		}
		if (reply.id == null) this.greeted = true
		// A reply to a request that already timed out must not answer the next one.
		const index = reply.id == null ? 0 : this.waiting.findIndex((w) => w.id === reply.id)
		if (index < 0) return
		const [waiter] = this.waiting.splice(index, 1)
		if (!waiter) return
		clearTimeout(waiter.timer)
		waiter.resolve(reply)
	}

	private expect(timeoutMs: number, id = 0): Promise<Reply> {
		return new Promise<Reply>((resolve) => {
			const timer = setTimeout(() => {
				const index = this.waiting.findIndex((waiter) => waiter.resolve === resolve)
				if (index >= 0) this.waiting.splice(index, 1)
				resolve({
					ok: false,
					error: 'the Windows helper did not answer in time',
				})
			}, timeoutMs)
			this.waiting.push({ id, resolve, timer })
		})
	}

	private async call<T>(command: Record<string, unknown>): Promise<T> {
		const proc = this.proc
		if (!proc || this.exited)
			throw new Error(this.exitReason ?? 'the Windows helper is not running')
		const id = this.nextId++
		const reply = this.expect(this.options.requestTimeoutMs ?? 10_000, id)
		proc.write(JSON.stringify({ ...command, id }))
		const answer = await reply
		if (!answer.ok) throw new Error(answer.error ?? 'the Windows helper failed')
		return answer.r as T
	}
}
