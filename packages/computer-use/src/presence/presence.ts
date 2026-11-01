import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { PRESENCE_BOOTSTRAP, presenceScriptLine } from './helper-script.js'

/** What the operated window shows: that an agent is working in it. */
export type PresenceKind = 'click' | 'type' | 'move'

export interface PresenceMark {
	/** The window being operated. */
	readonly hwnd: number
	/** Where the action lands, in virtual-desktop pixels; absent for typing, which stays where the cursor is. */
	readonly at?: { readonly x: number; readonly y: number }
	readonly kind: PresenceKind
}

/**
 * The visible sign that an agent is operating a window: its own cursor and a
 * border around the window. It never takes input, never changes the
 * foreground window and is not captured by screenshots; a failure to show it
 * never fails an action.
 */
export interface Presence {
	/** Shows (or refreshes) the cursor and border for one action. Does not wait. */
	mark(mark: PresenceMark): void
	/**
	 * Starts the helper ahead of the first action, so that action already shows
	 * the overlay. Does not wait; safe to call again.
	 */
	warm(): void
	/** Removes both at once: the task ended or the session stopped. */
	hide(): void
	dispose(): Promise<void>
}

/** The ends of a started helper; the real one is a child process. */
export interface PresenceProcess {
	write(line: string): void
	onLine(handler: (line: string) => void): void
	onExit(handler: () => void): void
	kill(): void
}

export interface WindowsPresenceOptions {
	/** Windows PowerShell, as this process starts it. */
	readonly powershell: string
	readonly env?: NodeJS.ProcessEnv
	/** For tests. */
	readonly spawnHelper?: () => PresenceProcess
	/** Waiting for the helper to start (it compiles a small library), ms. Default 30 000. */
	readonly startTimeoutMs?: number
}

function spawnPowerShell(options: WindowsPresenceOptions): PresenceProcess {
	const child = spawn(
		options.powershell,
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			Buffer.from(PRESENCE_BOOTSTRAP, 'utf16le').toString('base64'),
		],
		{ env: options.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
	)
	child.stdin.on('error', () => undefined)
	child.on('error', () => undefined)
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
				// Closing the input lets the helper close its windows and end.
				child.stdin.end()
			} catch {
				// Already closed.
			}
			setTimeout(() => child.kill(), 2_000).unref()
		},
	}
}

const hex = (hwnd: number): string => `0x${hwnd.toString(16).toUpperCase()}`

/**
 * {@link Presence} on a Windows desktop (WSL included), drawn by one
 * long-lived PowerShell helper that starts on first use and is reused: an
 * update is one line written to it, not a process. If the helper cannot start,
 * or cannot keep its windows out of screen captures, nothing is shown.
 */
export class WindowsPresence implements Presence {
	private proc: PresenceProcess | undefined
	private starting: Promise<boolean> | undefined
	private dead = false
	private disposed = false

	constructor(private readonly options: WindowsPresenceOptions) {}

	/** Whether the overlay is available; false once it failed to start or exited. */
	get available(): boolean {
		return !this.dead && !this.disposed
	}

	mark(mark: PresenceMark): void {
		if (!this.available) return
		const line = JSON.stringify({
			cmd: 'act',
			hwnd: hex(mark.hwnd),
			kind: mark.kind,
			...(mark.at ? { x: Math.round(mark.at.x), y: Math.round(mark.at.y) } : {}),
		})
		void this.send(line)
	}

	warm(): void {
		if (this.available) void this.start()
	}

	hide(): void {
		// Only a started helper has anything to hide.
		if (this.proc && this.available) this.proc.write(JSON.stringify({ cmd: 'hide' }))
	}

	async dispose(): Promise<void> {
		this.disposed = true
		const proc = this.proc
		this.proc = undefined
		proc?.kill()
	}

	private async send(line: string): Promise<void> {
		const ready = await this.start()
		if (ready && this.proc && this.available) this.proc.write(line)
	}

	private start(): Promise<boolean> {
		this.starting ??= new Promise<boolean>((resolve) => {
			let proc: PresenceProcess
			try {
				proc = (this.options.spawnHelper ?? (() => spawnPowerShell(this.options)))()
			} catch {
				this.dead = true
				resolve(false)
				return
			}
			this.proc = proc
			let greeted = false
			const fail = (): void => {
				this.dead = true
				resolve(false)
				proc.kill()
			}
			const timer = setTimeout(fail, this.options.startTimeoutMs ?? 30_000)
			timer.unref()
			proc.onExit(() => {
				clearTimeout(timer)
				this.dead = true
				resolve(false)
			})
			proc.onLine((line) => {
				if (greeted) return
				greeted = true
				clearTimeout(timer)
				let hello: { ok?: boolean; excluded?: boolean }
				try {
					hello = JSON.parse(line) as { ok?: boolean; excluded?: boolean }
				} catch {
					fail()
					return
				}
				// Without capture exclusion the overlay could land in a screenshot: show nothing.
				if (hello.ok !== true || hello.excluded !== true) fail()
				else resolve(true)
			})
			proc.write(presenceScriptLine())
		})
		return this.starting
	}
}
