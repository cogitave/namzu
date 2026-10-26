/**
 * The away recap: one line that says where a conversation stands, shown after
 * the person has been out of the terminal for a while.
 *
 * It starts only from a blur the terminal reported (a terminal that never
 * reports focus never recaps). Three minutes after a turn ended, and no
 * sooner than two seconds after the blur began, the terminal is checked again;
 * if it is still blurred the recap is written, unless one of these holds:
 *
 * - it is switched off, a turn is running, or one recap is already being written;
 * - the composer holds a draft, a background agent or workflow is running, or
 *   a session loop is scheduled;
 * - the conversation has fewer than three typed prompts, or fewer than two
 *   since the previous recap, or its last row is already a recap;
 * - three attempts this turn have failed.
 *
 * Coming back (focus, or a turn starting) cancels the countdown and stops a
 * recap being written; a result that arrives afterwards is dropped.
 *
 * Pure of React and of the terminal: clock, timers and focus are handed in so
 * a test advances time itself.
 */

/** Wait after a turn ends. */
export const RECAP_WAIT_MS = 180_000
/** The countdown never ends sooner than this after the blur began. */
export const RECAP_BLUR_DEBOUNCE_MS = 2_000
/** Typed prompts a conversation needs before it is worth a recap. */
export const RECAP_MIN_PROMPTS = 3
/** Typed prompts needed since the previous recap. */
export const RECAP_MIN_PROMPTS_SINCE = 2
/** Failed attempts after which a turn stops trying. */
export const RECAP_MAX_FAILURES = 3
/** How many recaps in a launch carry the hint. */
export const RECAP_SUFFIX_COUNT = 3
/** The hint on the first recaps. */
export const RECAP_SUFFIX = ' (disable recaps in /config)'

export type RecapRowKind = 'prompt' | 'reply' | 'recap'

export interface AwayRecapDeps {
	readonly now: () => number
	readonly setTimer: (run: () => void, ms: number) => unknown
	readonly clearTimer: (handle: unknown) => void
	readonly focus: {
		state(): 'unknown' | 'focused' | 'blurred'
		subscribe(listener: () => void): () => void
	}
	/** Switched on in settings (and not by a headless run). */
	readonly enabled: () => boolean
	readonly isTurnRunning: () => boolean
	readonly draftPresent: () => boolean
	/** A background agent or workflow is still running. */
	readonly backgroundWorkPending: () => boolean
	readonly loopScheduled: () => boolean
	/** The conversation's rows, oldest first, reduced to what the rules count. */
	readonly rows: () => readonly RecapRowKind[]
	/** The recap text, or `undefined` on any failure. Must honour `signal`. */
	readonly generate: (signal: AbortSignal) => Promise<string | undefined>
	readonly append: (text: string) => void
	readonly waitMs?: number
}

export class AwayRecap {
	readonly #deps: AwayRecapDeps
	readonly #unsubscribe: () => void
	#timer: unknown = null
	#settledAt = 0
	#blurredAt = 0
	#failures = 0
	#shown = 0
	#inFlight: AbortController | null = null
	#disposed = false

	constructor(deps: AwayRecapDeps) {
		this.#deps = deps
		this.#unsubscribe = deps.focus.subscribe(() => this.#focusChanged())
	}

	get #wait(): number {
		return this.#deps.waitMs ?? RECAP_WAIT_MS
	}

	/** A turn started: the person is evidently here; whatever was counting down no longer applies. */
	turnStarted(): void {
		this.#cancelTimer()
		this.#abort()
	}

	/** A turn finished, whatever its outcome: start counting. */
	turnSettled(): void {
		if (this.#disposed) return
		this.#settledAt = this.#deps.now()
		this.#failures = 0
		this.#arm()
	}

	/** The setting changed, or something else the countdown depends on did: look again. */
	refresh(): void {
		if (this.#disposed) return
		this.#arm()
	}

	/** The conversation was replaced: nothing about the old one applies. */
	reset(): void {
		this.#cancelTimer()
		this.#abort()
		this.#settledAt = 0
		this.#failures = 0
	}

	dispose(): void {
		this.#disposed = true
		this.#unsubscribe()
		this.#cancelTimer()
		this.#abort()
	}

	#focusChanged(): void {
		if (this.#disposed) return
		if (this.#deps.focus.state() === 'blurred') {
			this.#blurredAt = this.#deps.now()
			this.#arm()
			return
		}
		this.#cancelTimer()
		this.#abort()
	}

	#cancelTimer(): void {
		if (this.#timer === null) return
		this.#deps.clearTimer(this.#timer)
		this.#timer = null
	}

	#abort(): void {
		this.#inFlight?.abort()
		this.#inFlight = null
	}

	#arm(): void {
		this.#cancelTimer()
		const deps = this.#deps
		if (!deps.enabled() || this.#settledAt === 0 || deps.isTurnRunning()) return
		if (deps.focus.state() !== 'blurred') return
		const now = deps.now()
		const delay = Math.max(
			0,
			this.#wait - (now - this.#settledAt),
			RECAP_BLUR_DEBOUNCE_MS - (now - this.#blurredAt),
		)
		this.#timer = deps.setTimer(() => {
			this.#timer = null
			this.#fire()
		}, delay)
	}

	#fire(): void {
		const deps = this.#deps
		if (deps.focus.state() !== 'blurred') return
		if (!deps.enabled() || deps.isTurnRunning() || this.#inFlight !== null) return
		if (this.#failures >= RECAP_MAX_FAILURES) return
		if (deps.draftPresent() || deps.backgroundWorkPending() || deps.loopScheduled()) return
		if (!this.#enoughToRecap(deps.rows())) return
		const controller = new AbortController()
		this.#inFlight = controller
		void this.#write(controller)
	}

	#enoughToRecap(rows: readonly RecapRowKind[]): boolean {
		if (rows.at(-1) === 'recap') return false
		const lastRecap = rows.lastIndexOf('recap')
		const prompts = rows.filter((row) => row === 'prompt').length
		if (prompts < RECAP_MIN_PROMPTS) return false
		if (lastRecap === -1) return true
		return (
			rows.slice(lastRecap + 1).filter((row) => row === 'prompt').length >= RECAP_MIN_PROMPTS_SINCE
		)
	}

	async #write(controller: AbortController): Promise<void> {
		let text: string | undefined
		try {
			text = await this.#deps.generate(controller.signal)
		} catch {
			text = undefined
		}
		if (controller.signal.aborted || this.#disposed) return
		if (this.#inFlight === controller) this.#inFlight = null
		if (text === undefined || text.trim().length === 0) {
			this.#failures += 1
			return
		}
		const hint = this.#shown < RECAP_SUFFIX_COUNT ? RECAP_SUFFIX : ''
		this.#shown += 1
		this.#deps.append(`${text.trim()}${hint}`)
	}
}
