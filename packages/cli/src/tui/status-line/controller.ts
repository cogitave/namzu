/**
 * When the status line command runs.
 *
 * The reference's rules, in order:
 *
 * - once when the line first mounts, and at once when the command string
 *   changes;
 * - 300 ms after any watched input changes (token usage, permission mode,
 *   model, effort, the pull request, a new assistant message): a burst of
 *   changes is one run;
 * - every `refreshInterval` seconds when that is set, through the same
 *   300 ms debounce;
 * - a new run aborts the previous one, and an aborted run's output is
 *   dropped, never shown;
 * - an empty or failed run clears the line: a stale line is worse than none.
 *
 * Timers and the clock come in as parameters so a test advances them.
 */

export const STATUS_LINE_DEBOUNCE_MS = 300

export interface StatusLineControllerSettings {
	readonly command: string
	readonly refreshIntervalSeconds?: number | undefined
}

export interface StatusLineControllerDeps {
	/** Runs the command with the current payload; resolves to the line, or `undefined` for none. */
	readonly run: (signal: AbortSignal, command: string) => Promise<string | undefined>
	readonly onText: (text: string | undefined) => void
	readonly setTimer?: (fn: () => void, ms: number) => unknown
	readonly clearTimer?: (handle: unknown) => void
}

export class StatusLineController {
	private readonly setTimer: (fn: () => void, ms: number) => unknown
	private readonly clearTimer: (handle: unknown) => void
	private settings: StatusLineControllerSettings | null = null
	private triggers: readonly unknown[] = []
	private debounce: unknown = null
	private interval: unknown = null
	private controller: AbortController | null = null
	private running = false
	private text: string | undefined

	constructor(private readonly deps: StatusLineControllerDeps) {
		this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
		this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
	}

	/** Feed the latest settings and the values whose change should re-run the command. */
	update(settings: StatusLineControllerSettings | null, triggers: readonly unknown[]): void {
		const previous = this.settings
		const changedTriggers =
			triggers.length !== this.triggers.length ||
			triggers.some((value, index) => !Object.is(value, this.triggers[index]))
		this.settings = settings
		this.triggers = triggers
		if (settings === null) {
			this.stop()
			return
		}
		if (previous === null || previous.command !== settings.command) {
			this.clearIntervalTimer()
			this.armInterval()
			this.runNow()
			return
		}
		if (previous.refreshIntervalSeconds !== settings.refreshIntervalSeconds) {
			this.clearIntervalTimer()
			this.armInterval()
		}
		if (changedTriggers) this.schedule()
	}

	stop(): void {
		this.settings = null
		this.clearDebounce()
		this.clearIntervalTimer()
		this.controller?.abort()
		this.controller = null
		this.running = false
		this.setText(undefined)
	}

	private setText(text: string | undefined): void {
		if (text === this.text) return
		this.text = text
		this.deps.onText(text)
	}

	private clearDebounce(): void {
		if (this.debounce !== null) this.clearTimer(this.debounce)
		this.debounce = null
	}

	private clearIntervalTimer(): void {
		if (this.interval !== null) this.clearTimer(this.interval)
		this.interval = null
	}

	private schedule(): void {
		this.clearDebounce()
		this.debounce = this.setTimer(() => {
			this.debounce = null
			this.runNow()
		}, STATUS_LINE_DEBOUNCE_MS)
	}

	private armInterval(): void {
		const seconds = this.settings?.refreshIntervalSeconds
		if (seconds === undefined) return
		const every = Math.max(1, seconds) * 1000
		const tick = (): void => {
			this.schedule()
			this.interval = this.setTimer(tick, every)
		}
		this.interval = this.setTimer(tick, every)
	}

	private runNow(): void {
		const settings = this.settings
		if (settings === null) return
		this.clearDebounce()
		this.controller?.abort()
		const controller = new AbortController()
		this.controller = controller
		this.running = true
		void this.deps
			.run(controller.signal, settings.command)
			.then(
				(text) => (controller.signal.aborted ? undefined : { text }),
				() => undefined,
			)
			.then((result) => {
				if (controller.signal.aborted) return
				if (this.controller === controller) this.running = false
				this.setText(result?.text)
			})
	}

	/** For tests: whether a run is in flight. */
	get busy(): boolean {
		return this.running
	}
}
