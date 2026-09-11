import { setTimeout as sleep } from 'node:timers/promises'
import type { ResidentAgendaState, ResidentAgendaStore, ResidentPursuit } from './agenda.js'
import { type ResidentStep, stepResident } from './loop.js'
import { ResidentConflictError } from './store.js'

/** @experimental Host result describes execution, not external-effect rollback. */
export interface ResidentHostResult {
	readonly status: 'idle' | 'paused' | 'unresolved' | 'cancelled' | 'limit' | 'contended'
	readonly stepsSettled: number
	readonly nextWakeAt: number | null
}

/** @experimental Explicit authorization to drive a finite number of background steps. */
export interface ResidentHostRunOptions {
	readonly signal: AbortSignal
	readonly maxSteps: number
	readonly maxIdleMs?: number
}

/** @experimental A developer callback may bind a different SDK run for each pursuit. */
export type ResidentPursuitStep = (
	pursuit: ResidentPursuit,
	signal: AbortSignal,
) => ReturnType<ResidentStep>

/**
 * @experimental Local driver for one durable agenda. Shared agenda admission
 * prevents overlapping pursuits across processes. Wake delivery is local;
 * another process must notify this host or start a new explicitly authorized run.
 */
export class ResidentHost {
	private controller: AbortController | undefined
	private active: Promise<ResidentHostResult> | undefined
	private idle: AbortController | undefined
	private generation = 0
	private controls: Promise<void> = Promise.resolve()
	private controlsPending = 0

	constructor(
		private readonly agenda: ResidentAgendaStore,
		private readonly step: ResidentPursuitStep,
	) {}

	/** Interrupt local idle waiting after the host learns of new durable state. */
	notify(): void {
		this.generation++
		this.idle?.abort()
	}

	private async snapshot(): Promise<ResidentAgendaState> {
		const state = await this.agenda.read()
		if (!state) throw new Error('Create the resident agenda before running the host.')
		return state
	}

	private async paused(value: boolean): Promise<void> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const state = await this.snapshot()
			if (state.paused === value) return
			try {
				await this.agenda.setPaused(state, value)
				return
			} catch (error) {
				if (!(error instanceof ResidentConflictError) || attempt === 7) throw error
			}
		}
	}

	private control(update: () => Promise<void>): Promise<void> {
		this.controlsPending++
		const pending = this.controls.then(update)
		this.controls = pending.catch(() => {})
		return pending.finally(() => {
			this.controlsPending--
		})
	}

	/**
	 * Signal current work and durably close future admission. Resolving this method
	 * is NOT quiescence: await the run promise before claiming the callback stopped.
	 * An interrupted admitted pursuit remains unresolved until reconciled explicitly.
	 */
	async pause(): Promise<void> {
		this.controller?.abort()
		this.notify()
		await this.control(() => this.paused(true))
	}

	/** Reauthorize future work only after this host's previous invocation drained. */
	async resume(): Promise<void> {
		if (this.controlsPending) throw new Error('Wait for pending resident controls before resuming.')
		if (this.active)
			throw new Error('Wait for the active resident invocation to drain before resuming.')
		await this.control(() => this.paused(false))
		this.notify()
	}

	/** Persist fresh evidence and interrupt this host's idle timer. */
	async wake(id: string, reason: string): Promise<void> {
		const state = await this.snapshot()
		const pursuit = state.pursuits.find((p) => p.id === id)
		if (!pursuit) throw new Error('Unknown resident pursuit.')
		await this.agenda.wake(id, pursuit.state, reason, Date.now())
		this.notify()
	}

	run(options: ResidentHostRunOptions): Promise<ResidentHostResult> {
		if (this.controlsPending) throw new Error('Wait for pending resident controls before running.')
		if (this.active) throw new Error('A resident host invocation is already active.')
		const maxIdleMs = options.maxIdleMs ?? 60_000
		if (
			!Number.isSafeInteger(options.maxSteps) ||
			options.maxSteps < 1 ||
			!Number.isSafeInteger(maxIdleMs) ||
			maxIdleMs < 0 ||
			maxIdleMs > 2_147_483_647
		)
			throw new TypeError('Invalid resident host limits.')
		const controller = new AbortController()
		this.controller = controller
		const signal = AbortSignal.any([controller.signal, options.signal])
		this.active = this.drive(options.maxSteps, maxIdleMs, signal).finally(() => {
			this.active = undefined
			this.controller = undefined
			this.idle = undefined
		})
		return this.active
	}

	private async drive(
		maxSteps: number,
		maxIdleMs: number,
		signal: AbortSignal,
	): Promise<ResidentHostResult> {
		let stepsSettled = 0
		try {
			while (true) {
				signal.throwIfAborted()
				const observed = this.generation
				const state = await this.snapshot()
				signal.throwIfAborted()
				if (state.paused) return { status: 'paused', stepsSettled, nextWakeAt: null }
				if (state.pursuits.some((p) => p.state.phase === 'running'))
					return { status: 'unresolved', stepsSettled, nextWakeAt: null }
				const waiting = state.pursuits.filter(
					(p) => p.state.phase === 'waiting' && p.state.wakeAt !== null,
				)
				const now = Date.now()
				// Fair, deterministic baseline; this is not model-authored initiative.
				const due = waiting
					.filter((p) => (p.state.wakeAt ?? 0) <= now)
					.sort(
						(a, b) =>
							a.state.stepsAdmitted - b.state.stepsAdmitted ||
							(a.state.wakeAt ?? 0) - (b.state.wakeAt ?? 0) ||
							a.id.localeCompare(b.id),
					)[0]
				if (due) {
					const result = await stepResident(
						this.agenda.execution(due.id),
						(current, abort) => this.step({ id: due.id, state: current }, abort),
						signal,
					)
					if (result.status === 'idle')
						return {
							status: result.reason === 'unresolved' ? 'unresolved' : 'contended',
							stepsSettled,
							nextWakeAt: null,
						}
					stepsSettled++
					if (stepsSettled >= maxSteps) return { status: 'limit', stepsSettled, nextWakeAt: null }
					continue
				}
				const nextWakeAt =
					waiting.length === 0 ? null : Math.min(...waiting.map((p) => p.state.wakeAt ?? now))
				if (observed !== this.generation) continue
				if (nextWakeAt === null || nextWakeAt - now > maxIdleMs)
					return { status: 'idle', stepsSettled, nextWakeAt }
				const idle = new AbortController()
				this.idle = idle
				try {
					await sleep(Math.max(1, nextWakeAt - now), undefined, {
						signal: AbortSignal.any([signal, idle.signal]),
					})
				} catch (error) {
					if (!idle.signal.aborted || signal.aborted) throw error
				} finally {
					if (this.idle === idle) this.idle = undefined
				}
			}
		} catch (error) {
			if (!signal.aborted) throw error
			return { status: 'cancelled', stepsSettled, nextWakeAt: null }
		}
	}
}
