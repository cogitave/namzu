import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	QueryParams,
	SessionEvent,
	ToolCallSummary,
	Turn,
} from '@namzu/sdk'
import type { AGUITurnUI } from './ui.js'

export type QuestionRequest = Extract<HITLDecisionRequest, { type: 'user_question' }>

/** A question or a frontend call's result the turn is waiting for, inside a tool. */
export interface Park {
	readonly questionId: string
	readonly kind: 'question' | 'frontend'
	readonly request: QuestionRequest
	/** Told to the client: an interrupt, or a run that ended with the call unanswered. */
	announced: boolean
	readonly resolve: (decision: HITLResumeDecision) => void
}

/** A read of the native source, taken by the run that consumes it. */
export type NativeOutcome = { next: IteratorResult<SessionEvent, Turn> } | { error: unknown }

/**
 * One native turn, possibly across several AG-UI runs.
 *
 * A run ends when the turn finishes, fails or pauses — or when the turn
 * starts waiting inside a tool for the client (a question, a frontend
 * tool's result). In that last case the turn is still running: the next run
 * on the thread hands the waiting tool its answer and goes on reading the
 * same source. Between those runs nothing reads the source, so the turn
 * cannot make progress nobody sees.
 */
export class LiveTurn {
	readonly controller = new AbortController()
	readonly signal: AbortSignal = this.controller.signal
	turnId: string | undefined
	/** The interrupt records the turn is waiting on while detached. */
	openRecords: readonly string[] = []
	/** When the soonest of those records expires, epoch ms. */
	expiresAt = Number.POSITIVE_INFINITY
	/** The host's query configuration, once `createQuery` returned it. */
	params: QueryParams | undefined
	/** The UI capability the turn's tools were built with. */
	ui: AGUITurnUI | undefined
	readonly parks = new Map<string, Park>()
	/** Frontend calls whose tool is waiting, by tool call id. */
	readonly frontendCalls = new Map<string, { readonly toolName: string; readonly input: unknown }>()
	/** Decisions the host answered `pause`, by the checkpoint they parked. */
	readonly paused = new Map<string, HITLDecisionRequest>()
	/** The calls a paused review asked the client about, by checkpoint. */
	readonly reviewCalls = new Map<string, readonly ToolCallSummary[]>()
	/** Tool calls some run of this turn already announced on the wire. */
	readonly announcedToolCalls = new Map<string, string>()
	private source: AsyncGenerator<SessionEvent, Turn> | undefined
	private pendingRead: Promise<void> | undefined
	private outcome: NativeOutcome | undefined
	private done = false
	private notify: (() => void) | undefined
	private notified = false
	private readonly listeners = new Map<AGUITurnUI, () => void>()
	private unlink: (() => void) | undefined
	private expiry: ReturnType<typeof setTimeout> | undefined
	private detachedProgress: (() => void) | undefined

	constructor() {
		this.signal.addEventListener('abort', () => this.releaseParks(), { once: true })
	}

	/** Abort with the host's own signal, for the whole life of the turn. */
	follow(hostSignal: AbortSignal | undefined): void {
		if (!hostSignal) return
		const abort = () => this.controller.abort(hostSignal.reason)
		if (hostSignal.aborted) abort()
		else hostSignal.addEventListener('abort', abort, { once: true })
	}

	get started(): boolean {
		return this.source !== undefined
	}

	get settled(): boolean {
		return this.done
	}

	start(source: AsyncGenerator<SessionEvent, Turn>): void {
		if (this.source) throw new Error('This turn already has a source')
		this.source = source
		this.pull()
	}

	/** Ask for the next native event unless a read is already outstanding. */
	pull(): void {
		if (!this.source || this.done || this.pendingRead) return
		this.pendingRead = this.source.next().then(
			(next) => {
				this.pendingRead = undefined
				if (next.done) this.done = true
				this.outcome = { next }
				this.wake()
				this.detachedProgress?.()
			},
			(error: unknown) => {
				this.pendingRead = undefined
				this.done = true
				this.outcome = { error }
				this.wake()
				this.detachedProgress?.()
			},
		)
	}

	/**
	 * Whether the source produced something nobody read: while detached, that
	 * means the waiting tool stopped waiting (its own deadline, or an abort)
	 * and the turn went on without the client's answer.
	 */
	get progressed(): boolean {
		return this.outcome !== undefined
	}

	take(): NativeOutcome | undefined {
		const outcome = this.outcome
		this.outcome = undefined
		return outcome
	}

	/** Parks the client has not been told about yet, oldest first. */
	unannounced(): Park[] {
		return [...this.parks.values()].filter((park) => !park.announced)
	}

	/** Wait inside a tool for the client. Resolved by {@link answer} or by the turn ending. */
	park(request: QuestionRequest, kind: Park['kind']): Promise<HITLResumeDecision> {
		// A question from any other turn — a delegated child's — is not this
		// run's to put in front of the client.
		if (this.signal.aborted || (this.turnId !== undefined && request.turnId !== this.turnId)) {
			return Promise.resolve({ action: 'continue' })
		}
		const questionId = request.question.questionId
		if (this.parks.has(questionId)) {
			return Promise.resolve({ action: 'continue' })
		}
		return new Promise<HITLResumeDecision>((resolve) => {
			this.parks.set(questionId, {
				questionId,
				kind,
				request,
				announced: false,
				resolve: (decision) => {
					this.parks.delete(questionId)
					resolve(decision)
				},
			})
			this.wake()
		})
	}

	/** Hand a waiting tool its answer. False when nothing waits under that id. */
	answer(questionId: string, decision: HITLResumeDecision): boolean {
		const park = this.parks.get(questionId)
		if (!park) return false
		park.resolve(decision)
		return true
	}

	/** Deliver UI events and parks to whoever is waiting in {@link wait}. */
	watch(ui: AGUITurnUI): void {
		if (this.listeners.has(ui)) return
		this.listeners.set(
			ui,
			ui.onEvent(() => this.wake()),
		)
	}

	unwatch(ui: AGUITurnUI): void {
		this.listeners.get(ui)?.()
		this.listeners.delete(ui)
	}

	/** The turn follows this request's cancellation until {@link detach}. */
	attach(requestSignal: AbortSignal | undefined): void {
		this.detachedProgress = undefined
		this.clearExpiry()
		this.unlink?.()
		this.unlink = undefined
		if (!requestSignal) return
		const abort = () => this.controller.abort(requestSignal.reason)
		if (requestSignal.aborted) abort()
		else {
			requestSignal.addEventListener('abort', abort, { once: true })
			this.unlink = () => requestSignal.removeEventListener('abort', abort)
		}
	}

	/**
	 * Stop following the request. `onExpire` runs if nobody attaches within
	 * `ms`, or as soon as the source moves on without the client.
	 */
	detach(ms: number, onExpire: () => void): void {
		this.unlink?.()
		this.unlink = undefined
		this.clearExpiry()
		let fired = false
		const expire = () => {
			if (fired) return
			fired = true
			this.detachedProgress = undefined
			this.clearExpiry()
			onExpire()
		}
		this.detachedProgress = expire
		// setTimeout reads anything past 2^31-1 ms as 1 ms.
		this.expiry = setTimeout(expire, Math.min(Math.max(0, ms), 2_147_483_647))
		this.expiry.unref?.()
		if (this.progressed) expire()
	}

	async wait(signal: AbortSignal): Promise<void> {
		try {
			if (this.notified) return
			await new Promise<void>((resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason)
					return
				}
				const abort = () => reject(signal.reason)
				signal.addEventListener('abort', abort, { once: true })
				this.notify = () => {
					signal.removeEventListener('abort', abort)
					resolve()
				}
			})
		} finally {
			this.notified = false
			this.notify = undefined
		}
	}

	abort(reason: unknown): void {
		this.controller.abort(reason)
		this.releaseParks()
	}

	/** Read the source to its end, so the kernel records how the turn settled. */
	async drain(): Promise<void> {
		if (!this.source) return
		await this.pendingRead
		if (this.outcome && 'next' in this.outcome && this.outcome.next.done) this.done = true
		this.outcome = undefined
		while (!this.done) {
			try {
				this.done = (await this.source.next()).done === true
			} catch (error) {
				this.done = true
				throw error
			}
		}
	}

	/** Release everything this turn holds; the source is left to {@link drain}. */
	close(): void {
		this.detachedProgress = undefined
		this.clearExpiry()
		this.unlink?.()
		this.unlink = undefined
		for (const ui of [...this.listeners.keys()]) this.unwatch(ui)
		this.releaseParks()
	}

	private wake(): void {
		this.notified = true
		this.notify?.()
	}

	private clearExpiry(): void {
		if (this.expiry !== undefined) clearTimeout(this.expiry)
		this.expiry = undefined
	}

	private releaseParks(): void {
		// A question the turn stopped waiting for is not answered: the asking
		// tool reads `abort` as "stop", never as consent.
		for (const park of [...this.parks.values()]) {
			park.resolve({ action: 'abort', reason: 'The turn ended before the client answered.' })
		}
	}
}

/**
 * An async generator over a listener-based producer, one event ahead at
 * most: the producer's listener returns only when the consumer has asked
 * for the event after the one it delivered.
 *
 * Returning early releases the producer without waiting on the consumer;
 * the caller aborts the producer first, so it settles instead of running
 * on unobserved.
 */
export function fromListener<T, R>(
	run: (emit: (value: T) => Promise<void>) => Promise<R>,
): AsyncGenerator<T, R> {
	const queue: { value: T; taken: () => void }[] = []
	let notify: (() => void) | undefined
	let released = false
	let settled: { ok: true; value: R } | { ok: false; error: unknown } | undefined
	const wake = () => {
		const resolve = notify
		notify = undefined
		resolve?.()
	}
	const emit = (value: T): Promise<void> =>
		released
			? Promise.resolve()
			: new Promise<void>((taken) => {
					queue.push({ value, taken })
					wake()
				})
	let done: Promise<void> | undefined
	return (async function* () {
		done = run(emit).then(
			(value) => {
				settled = { ok: true, value }
			},
			(error: unknown) => {
				settled = { ok: false, error }
			},
		)
		void done.finally(wake)
		try {
			while (true) {
				const item = queue.shift()
				if (item) {
					try {
						yield item.value
					} finally {
						item.taken()
					}
					continue
				}
				if (settled) {
					if (settled.ok) return settled.value
					throw settled.error
				}
				await new Promise<void>((resolve) => {
					notify = resolve
				})
			}
		} finally {
			released = true
			for (const item of queue.splice(0)) item.taken()
			await done
		}
	})()
}
