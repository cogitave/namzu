/** The part of Electron's power-save blocker the guard uses. */
export interface PowerBlocker {
	start(type: 'prevent-app-suspension'): number
	stop(id: number): void
	isStarted(id: number): boolean
}

/** Whether the computer runs on battery, and a way to hear it change. */
export interface BatteryWatch {
	onBattery(): boolean
	subscribe(listener: () => void): () => void
}

export interface SleepWishes {
	appOpen: boolean
	whileWorking: boolean
	onBattery: boolean
}

/**
 * Blocks idle system sleep (never the display's) for two reasons that are kept apart: Namzu is open,
 * or a conversation is working. Each holds its own blocker, so one ending never lets go of the other.
 * While working, a computer on battery is left to sleep unless the person said otherwise.
 */
export class SleepGuard {
	private appBlocker: number | undefined
	private workBlocker: number | undefined
	private unsubscribe: (() => void) | undefined

	constructor(
		private readonly blocker: PowerBlocker,
		private readonly battery: BatteryWatch,
		private readonly working: () => number,
		private readonly wishes: () => SleepWishes,
	) {}

	/** Starts listening for the power source changing. */
	start(): void {
		this.unsubscribe ??= this.battery.subscribe(() => this.update())
		this.update()
	}

	/** Looks at the wishes, the running conversations and the power source, and holds what is wanted. */
	update(): void {
		const wishes = this.wishes()
		this.appBlocker = this.hold(this.appBlocker, wishes.appOpen)
		const working =
			wishes.whileWorking && this.working() > 0 && (wishes.onBattery || !this.battery.onBattery())
		this.workBlocker = this.hold(this.workBlocker, working)
	}

	/**
	 * Looks again once the current synchronous span is over. A conversation reports its end while it
	 * still counts as working and stops counting a moment later in the same span, so a look taken
	 * at the report alone would keep the computer awake after the work ended.
	 */
	updateSoon(): void {
		queueMicrotask(() => this.update())
	}

	/** Which of the two reasons holds the computer awake right now. */
	holding(): { appOpen: boolean; working: boolean } {
		return {
			appOpen: this.appBlocker !== undefined,
			working: this.workBlocker !== undefined,
		}
	}

	close(): void {
		this.unsubscribe?.()
		this.unsubscribe = undefined
		this.appBlocker = this.hold(this.appBlocker, false)
		this.workBlocker = this.hold(this.workBlocker, false)
	}

	private hold(current: number | undefined, wanted: boolean): number | undefined {
		const live = current !== undefined && this.blocker.isStarted(current)
		if (wanted) return live ? current : this.blocker.start('prevent-app-suspension')
		if (current !== undefined && live) this.blocker.stop(current)
		return undefined
	}
}
