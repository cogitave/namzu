/**
 * What happens to memory over time, off the turn's path.
 *
 * One host for the session: it feeds the usage file from what recall did,
 * sets aside what a refused request carried, flushes at turn release and
 * when idle, and runs the sweep when the person is away.
 *
 * The sweep waits for the same quiet as the curator's idle drain: no turn
 * running, nothing typed (`isBusy`), and a pause after the last turn. It runs
 * at most once in `SWEEP_MIN_GAP_MS`. `/memory tidy` runs it at once.
 *
 * Pure of the terminal: the clock and the timers are handed in.
 */

import type { LogAttributes, MarkdownMemoryStore, SessionEvent } from '@namzu/sdk'

import { RECALLED_MEMORY_KEY } from './manage.js'
import { type SweepReport, sweepMemory } from './sweep.js'
import type { MemoryUsage } from './usage.js'

/** How long after a turn settles the idle sweep waits. */
export const SWEEP_IDLE_MS = 15_000
/** The least time between two idle sweeps of one process. */
export const SWEEP_MIN_GAP_MS = 6 * 3_600_000

export interface MemoryLifecycleDeps {
	readonly store: MarkdownMemoryStore
	readonly usage: MemoryUsage
	readonly now: () => number
	readonly setTimer: (run: () => void | Promise<void>, ms: number) => unknown
	readonly clearTimer: (handle: unknown) => void
	/** Days without a recall before a recorded memory is retired; 0 never retires. */
	readonly retireAfterDays: number
	/** Whether the person is using the terminal right now. Read at fire time; defaults to not. */
	readonly isBusy?: () => boolean
	/** Whether the curator is draining its inbox; the sweep waits for it to finish. */
	readonly isDraining?: () => boolean
	/** Counts only, never titles. */
	readonly log?: (message: string, fields: LogAttributes) => void
	/** A sweep that changed something. */
	readonly onSwept?: (report: SweepReport) => void
}

export class MemoryLifecycle {
	readonly #deps: MemoryLifecycleDeps
	#timer: unknown = null
	#turnRunning = false
	/** The sweep in flight, so a second one queues behind it. */
	#inflight: Promise<unknown> | undefined
	#lastSweepAt: number | undefined
	#disposed = false
	/** A refused request was retried without the memories it carried. */
	#withheld = false

	constructor(deps: MemoryLifecycleDeps) {
		this.#deps = deps
	}

	/** The keys a refused request is retried without. */
	readonly withholdOnRefusal: readonly string[] = [RECALLED_MEMORY_KEY]

	/** Keys withheld from every request of the session once one refusal was retried without them. */
	withheldKeys(): readonly string[] {
		return this.#withheld ? [RECALLED_MEMORY_KEY] : []
	}

	/** The ids recall must not offer. */
	excluded = (): Set<string> => this.#deps.usage.setAsideIds()

	/** Read the usage file and arm the first idle sweep. */
	async start(): Promise<void> {
		await this.#deps.usage.load()
		this.#arm()
	}

	/** Every session event of a turn. */
	observe(event: SessionEvent): void {
		switch (event.type) {
			case 'memory_recalled': {
				const ids = event.memories.map((memory) => memory.id)
				const chosen = event.memories
					.filter((memory) => memory.reason !== undefined && memory.reason !== 'matched words')
					.map((memory) => memory.id)
				this.#deps.usage.recalled(ids, chosen)
				return
			}
			case 'model_refusal':
				if (event.outcome === 'withheld') {
					this.#withheld = true
					const ids = event.withheldMemoryIds ?? []
					this.#deps.usage.setAside(ids)
					this.#deps.log?.('memory set aside after a refusal', {
						'namzu.memory.lifecycle.set_aside_count': ids.length,
					})
					// A refusal is not waited on: the person may leave before the turn ends.
					void this.#deps.usage.flush()
				}
				return
			case 'turn_completed':
			case 'turn_failed':
				this.turnSettled()
				return
			default:
		}
	}

	/** A turn is starting: the idle sweep is off. */
	turnStarted(): void {
		if (this.#disposed) return
		this.#turnRunning = true
		this.#cancel()
	}

	/** A turn released: write the counts, then wait for quiet. */
	turnSettled(): void {
		if (this.#disposed) return
		this.#turnRunning = false
		void this.#deps.usage.flush()
		this.#arm()
	}

	/** Lift the set-aside of one record and write it. */
	async restore(id: string): Promise<void> {
		this.#deps.usage.restore(id)
		await this.#deps.usage.flush()
	}

	/** The sweep, now. Never waits for quiet. */
	async tidy(): Promise<SweepReport> {
		await this.#deps.usage.flush()
		const report = await this.#serial(() => this.#sweep())
		this.#lastSweepAt = this.#deps.now()
		return report
	}

	/** One sweep at a time: a run waits for the one in flight. */
	async #serial<T>(run: () => Promise<T>): Promise<T> {
		const behind = this.#inflight
		const current = (async () => {
			if (behind) await behind.catch(() => undefined)
			return run()
		})()
		this.#inflight = current
		try {
			return await current
		} finally {
			if (this.#inflight === current) this.#inflight = undefined
		}
	}

	async #sweep(shouldStop?: () => boolean): Promise<SweepReport> {
		const report = await sweepMemory({
			store: this.#deps.store,
			usage: this.#deps.usage,
			now: this.#deps.now,
			retireAfterDays: this.#deps.retireAfterDays,
			...(shouldStop ? { shouldStop } : {}),
		})
		this.#deps.log?.('memory sweep finished', {
			'namzu.memory.sweep.archived_count': report.archived.length,
			'namzu.memory.sweep.unused_count': report.archived.filter((item) => item.reason === 'unused')
				.length,
			'namzu.memory.sweep.duplicate_count': report.archived.filter(
				(item) => item.reason === 'duplicate',
			).length,
			'namzu.memory.sweep.possibly_stale_count': report.possiblyStale.length,
			'namzu.memory.sweep.kept_count': report.kept,
		})
		return report
	}

	#cancel(): void {
		if (this.#timer === null) return
		this.#deps.clearTimer(this.#timer)
		this.#timer = null
	}

	#arm(): void {
		if (this.#disposed || this.#turnRunning) return
		this.#cancel()
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = null
			// Returned, so a caller that wants to wait for the sweep can.
			return this.#idle()
		}, SWEEP_IDLE_MS)
	}

	async #idle(): Promise<void> {
		if (this.#disposed || this.#turnRunning || this.#inflight) return
		if (this.#deps.isBusy?.() === true || this.#deps.isDraining?.() === true) {
			// Someone is using the terminal: look again after the next pause.
			this.#arm()
			return
		}
		const last = this.#lastSweepAt
		if (last !== undefined && this.#deps.now() - last < SWEEP_MIN_GAP_MS) return
		try {
			await this.#deps.usage.flush()
			// A turn starting, or the curator draining, stops the sweep between writes.
			const report = await this.#serial(() =>
				this.#sweep(
					() => this.#turnRunning || this.#disposed || this.#deps.isDraining?.() === true,
				),
			)
			this.#lastSweepAt = this.#deps.now()
			if (report.archived.length > 0) this.#deps.onSwept?.(report)
		} catch {
			this.#deps.log?.('memory sweep failed', { 'namzu.memory.sweep.reason': 'store' })
		}
	}

	/** Write what is pending and stop arming. */
	async dispose(): Promise<void> {
		if (this.#disposed) return
		this.#disposed = true
		this.#cancel()
		await this.#deps.usage.flush()
	}
}
