/**
 * The questions waiting on the person, one on screen at a time.
 *
 * With per-call review a turn can have several questions open at once: the
 * calls that are safe to run side by side each ask for themselves, and other
 * agents ask through the same screen. This is the queue behind that screen. It
 * holds no React state; the app shows whatever it reports and answers through
 * it, so the rules below are testable without a terminal.
 *
 * - First asked, first shown. A question from another agent (a background ask)
 *   waits behind every question of the person's own conversation, but never
 *   takes the screen from the one already up.
 * - "k of N": `settled + 1` of `settled + open`, shown when that total is two
 *   or more, so the last of several questions still reads "3 of 3" once the
 *   others are answered. A question closed without being shown (a rule now
 *   covers it) still counts as settled, so the numbers move the way the person
 *   would count. The count starts over when nothing is open.
 * - A question whose signal aborts (the turn was stopped, a rule now covers
 *   it) is closed and its answer is ignored by the kernel.
 */

import type { PermissionDecision } from './agent.js'

/** What a question that was closed from outside is answered with; the kernel ignores it. */
export const CLOSED_QUESTION: PermissionDecision = {
	kind: 'reject',
	feedback: 'The question was closed.',
}

interface Ask<T> {
	readonly value: T
	readonly resolve: (decision: PermissionDecision) => void
	readonly background: boolean
	readonly detach: () => void
}

export interface AskCount {
	/** Which question this is, counting those already settled. */
	readonly position: number
	readonly total: number
}

export class AskQueue<T> {
	#shown: Ask<T> | null = null
	#waiting: Ask<T>[] = []
	#settled = 0
	readonly #onShow: (value: T | null) => void
	readonly #onChange: () => void

	/**
	 * `onShow` is told which question is on screen whenever that changes (`null`:
	 * none); `onChange` after any change at all, the count behind the title included.
	 */
	constructor(onShow: (value: T | null) => void, onChange: () => void = () => {}) {
		this.#onShow = onShow
		this.#onChange = onChange
	}

	/** The question on screen. */
	get shown(): T | null {
		return this.#shown?.value ?? null
	}

	/** Questions open now: the one on screen and those waiting. */
	get open(): number {
		return (this.#shown ? 1 : 0) + this.#waiting.length
	}

	/** Questions waiting behind the one on screen. */
	get waiting(): number {
		return this.#waiting.length
	}

	/**
	 * The "k of N" for the question on screen, or none while the set holds fewer
	 * than two questions (those settled since it began and those open now).
	 */
	count(): AskCount | undefined {
		if (this.open === 0) return undefined
		const total = this.#settled + this.open
		if (total < 2) return undefined
		return { position: this.#settled + 1, total }
	}

	/** Every open question, the one on screen first. */
	values(): readonly T[] {
		return [...(this.#shown ? [this.#shown.value] : []), ...this.#waiting.map((a) => a.value)]
	}

	/**
	 * Put a question to the person. The promise settles with the answer, or with
	 * {@link CLOSED_QUESTION} when `signal` aborts first.
	 */
	enqueue(
		value: T,
		options: { background?: boolean; signal?: AbortSignal } = {},
	): Promise<PermissionDecision> {
		const signal = options.signal
		if (signal?.aborted) return Promise.resolve(CLOSED_QUESTION)
		return new Promise<PermissionDecision>((resolve) => {
			const onAbort = () => this.#close(ask, CLOSED_QUESTION)
			const ask: Ask<T> = {
				value,
				resolve,
				background: options.background === true,
				detach: () => signal?.removeEventListener('abort', onAbort),
			}
			signal?.addEventListener('abort', onAbort, { once: true })
			if (this.#shown === null) {
				this.#shown = ask
				this.#onShow(value)
				this.#onChange()
				return
			}
			if (ask.background) {
				this.#waiting.push(ask)
			} else {
				const firstBackground = this.#waiting.findIndex((other) => other.background)
				if (firstBackground < 0) this.#waiting.push(ask)
				else this.#waiting.splice(firstBackground, 0, ask)
			}
			this.#onChange()
		})
	}

	/** Answer the question on screen. Returns whether there was one. */
	answer(decision: PermissionDecision): boolean {
		const ask = this.#shown
		if (!ask) return false
		this.#close(ask, decision)
		return true
	}

	/**
	 * Close every open question the rule decides, shown or waiting, with the
	 * decision it returns. A question the rule leaves (`undefined`) stays open.
	 * Returns how many were closed.
	 */
	settleWhere(decide: (value: T, shown: boolean) => PermissionDecision | undefined): number {
		const decided: [Ask<T>, PermissionDecision][] = []
		if (this.#shown) {
			const decision = decide(this.#shown.value, true)
			if (decision) decided.push([this.#shown, decision])
		}
		for (const ask of this.#waiting) {
			const decision = decide(ask.value, false)
			if (decision) decided.push([ask, decision])
		}
		if (decided.length === 0) return 0
		const closing = new Set(decided.map(([ask]) => ask))
		const shownClosing = this.#shown !== null && closing.has(this.#shown)
		this.#waiting = this.#waiting.filter((ask) => !closing.has(ask))
		this.#settled += decided.length
		if (shownClosing) {
			this.#shown = this.#waiting.shift() ?? null
			this.#onShow(this.#shown?.value ?? null)
		}
		this.#restartCount()
		this.#onChange()
		for (const [ask, decision] of decided) {
			ask.detach()
			ask.resolve(decision)
		}
		return decided.length
	}

	/** Answer every open question the same way and start the count over. */
	closeAll(decision: PermissionDecision): void {
		const all = [...(this.#shown ? [this.#shown] : []), ...this.#waiting]
		this.#shown = null
		this.#waiting = []
		this.#settled = 0
		if (all.length === 0) return
		this.#onShow(null)
		this.#onChange()
		for (const ask of all) {
			ask.detach()
			ask.resolve(decision)
		}
	}

	#close(ask: Ask<T>, decision: PermissionDecision): void {
		if (this.#shown === ask) {
			this.#settled += 1
			this.#shown = this.#waiting.shift() ?? null
			this.#restartCount()
			this.#onShow(this.#shown?.value ?? null)
		} else {
			const index = this.#waiting.indexOf(ask)
			if (index < 0) return
			this.#waiting.splice(index, 1)
			this.#settled += 1
			this.#restartCount()
		}
		this.#onChange()
		ask.detach()
		ask.resolve(decision)
	}

	#restartCount(): void {
		if (this.open === 0) this.#settled = 0
	}
}
