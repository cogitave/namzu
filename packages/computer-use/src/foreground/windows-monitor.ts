import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ForegroundMonitor, MonitorBurstEnd, MonitorState } from './types.js'
import { WINDOWS_HELPER_SCRIPT } from './windows-helper-script.js'

/** The ends of a started helper; the real one is a child process. */
export interface HelperProcess {
	write(line: string): void
	onLine(handler: (line: string) => void): void
	onExit(handler: () => void): void
	kill(): void
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
}

/** The helper script as PowerShell's `-EncodedCommand` takes it. */
export function encodeHelperCommand(script: string = WINDOWS_HELPER_SCRIPT): string {
	return Buffer.from(script, 'utf16le').toString('base64')
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
		{ env: options.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
	)
	// Without a listener a helper that exits first turns a write into an uncaught error.
	child.stdin.on('error', () => undefined)
	return {
		write: (line) => {
			child.stdin.write(`${line}\n`)
		},
		onLine: (handler) => createInterface({ input: child.stdout }).on('line', handler),
		onExit: (handler) => {
			child.once('exit', handler)
			child.once('error', handler)
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

	constructor(private readonly options: WindowsMonitorOptions) {}

	async start(): Promise<void> {
		if (this.proc) return
		const proc = (this.options.spawnHelper ?? (() => spawnPowerShell(this.options)))(
			WINDOWS_HELPER_SCRIPT,
		)
		this.proc = proc
		proc.onLine((line) => this.onLine(line))
		proc.onExit(() => {
			this.exited = true
			for (const waiter of this.waiting.splice(0)) {
				clearTimeout(waiter.timer)
				waiter.resolve({ ok: false, error: 'the Windows helper exited' })
			}
		})
		const hello = await this.expect(this.options.startTimeoutMs ?? 60_000)
		if (!hello.ok || hello.hooks !== true) {
			await this.dispose()
			throw new Error(
				hello.hookError || hello.error || 'the keyboard and mouse hooks did not start',
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
		if (!proc || this.exited) throw new Error('the Windows helper is not running')
		const id = this.nextId++
		const reply = this.expect(this.options.requestTimeoutMs ?? 10_000, id)
		proc.write(JSON.stringify({ ...command, id }))
		const answer = await reply
		if (!answer.ok) throw new Error(answer.error ?? 'the Windows helper failed')
		return answer.r as T
	}
}
