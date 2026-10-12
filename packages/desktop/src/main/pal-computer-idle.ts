/**
 * Shuts the Linux machine for Pal computers down once no Pal computer has run for a while. Desktop
 * only watches the states it shows; `computer stop-idle` itself refuses while anything runs, so a
 * computer this class did not see is never stopped.
 */
export interface IdleStopperOptions {
	delayMs: number
	/** Calls `computer stop-idle`; resolves to what it answered. */
	stop: (timeoutMs?: number) => Promise<'stopped' | 'busy' | 'not-running' | 'failed'>
	/** Runs `run` after `ms`; returns the way to cancel it. */
	schedule: (ms: number, run: () => void) => () => void
	/** True while Desktop itself is setting a PC up: the machine is in use even with no computer running. */
	busy?: () => boolean
}

/** How long quitting waits for the idle stop before it goes on without it. */
export const QUIT_STOP_TIMEOUT_MS = 5000

export class IdleStopper {
	private readonly running = new Set<string>()
	private cancel: (() => void) | undefined
	private started = false

	constructor(private readonly options: IdleStopperOptions) {}

	/** Begin watching; nothing has run yet, so the countdown starts now. */
	start(): void {
		this.started = true
		this.arm()
	}

	/** A Pal's computer was seen running or not running. */
	observe(palId: string, running: boolean): void {
		const before = this.running.size
		if (running) this.running.add(palId)
		else this.running.delete(palId)
		if (!this.started || this.running.size === before) return
		if (this.running.size > 0) this.disarm()
		else this.arm()
	}

	get anyRunning(): boolean {
		return this.running.size > 0
	}

	/** On quit: stop the machine now when no Pal computer runs. */
	async stopForQuit(): Promise<void> {
		this.disarm()
		if (this.running.size > 0 || this.options.busy?.()) return
		// Quitting must not wait on a Linux machine that does not answer.
		await this.options.stop(QUIT_STOP_TIMEOUT_MS)
	}

	dispose(): void {
		this.started = false
		this.disarm()
	}

	private arm(): void {
		this.disarm()
		this.cancel = this.options.schedule(this.options.delayMs, () => {
			this.cancel = undefined
			void this.fire()
		})
	}

	private disarm(): void {
		this.cancel?.()
		this.cancel = undefined
	}

	private async fire(): Promise<void> {
		if (this.running.size > 0) return
		if (this.options.busy?.()) {
			this.arm()
			return
		}
		const outcome = await this.options.stop()
		// Something still runs that Desktop did not see: look again after another quiet period.
		if (outcome === 'busy' && this.started && this.running.size === 0) this.arm()
	}
}
