import { setTimeout as sleep } from 'node:timers/promises'
import {
	type ResidentAgendaState,
	type ResidentAgendaStore,
	type ResidentContextualStep,
	ResidentHost,
	type ResidentHostResult,
} from '@namzu/sdk'

export interface ResidentForegroundOptions {
	readonly agenda: ResidentAgendaStore
	readonly step: ResidentContextualStep
	readonly signal: AbortSignal
	readonly maxSteps: number
	readonly maxIdleMs?: number
	/** Remain idle until explicitly stopped or the original work limit is consumed. */
	readonly keepAlive?: boolean
	/** A launcher binds admission to the pause generation that authorized it. */
	readonly expectedPauseGeneration?: number
	/** Optional host ownership check; called at admission and during local monitoring. */
	readonly checkControl?: () => Promise<void>
	/** Local storage checks, never provider calls. */
	readonly pollIntervalMs?: number
}

/** One explicitly authorized foreground invocation, with cross-process stop observation. */
export async function runResidentForeground(
	options: ResidentForegroundOptions,
): Promise<ResidentHostResult> {
	const { agenda } = options
	if (!agenda.executionAt) throw new Error('Resident execution requires atomic admission.')
	const interval = options.pollIntervalMs ?? 250
	if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000)
		throw new Error('Invalid resident control polling interval.')
	options.signal.throwIfAborted()
	const initial = await agenda.read()
	if (!initial) throw new Error('No resident agenda exists here.')
	const generation = options.expectedPauseGeneration ?? initial.pauseGeneration ?? 0
	const controller = new AbortController()
	const signal = AbortSignal.any([options.signal, controller.signal])
	const fence = (state: ResidentAgendaState | null): ResidentAgendaState => {
		if (!state) throw new Error('Resident agenda disappeared during execution.')
		if ((state.pauseGeneration ?? 0) !== generation)
			controller.abort(new Error('A durable pause request ended this invocation.'))
		return state
	}
	const read = async () => {
		await options.checkControl?.()
		return fence(await agenda.read())
	}
	const guarded: ResidentAgendaStore = {
		read,
		create: (...args) => agenda.create(...args),
		add: (...args) => agenda.add(...args),
		setPaused: (...args) => agenda.setPaused(...args),
		wake: (...args) => agenda.wake(...args),
		execution: (id) => agenda.execution(id),
		executionAt: (id, expected) => {
			const execution = agenda.executionAt?.(id, expected)
			if (!execution) throw new Error('Resident atomic admission was removed.')
			return {
				read: () => execution.read(),
				claim: async (...args) => {
					await read()
					signal.throwIfAborted()
					// Keep the exact learning/admission snapshot. Do not substitute the
					// newer control read for the snapshot projected into this step.
					return execution.claim(...args)
				},
				settle: (...args) => execution.settle(...args),
			}
		},
	}
	const host = new ResidentHost(
		guarded,
		async (...args) => {
			await read()
			signal.throwIfAborted()
			return options.step(...args)
		},
		{ learning: true },
	)
	const monitorStop = new AbortController()
	let monitorFailure: unknown
	let lastRevision = initial.revision
	const monitor = (async () => {
		try {
			while (!monitorStop.signal.aborted) {
				await sleep(interval, undefined, { signal: monitorStop.signal })
				const state = await read()
				if (state.revision !== lastRevision) {
					lastRevision = state.revision
					host.notify()
				}
			}
		} catch (error) {
			if (!monitorStop.signal.aborted) {
				monitorFailure = error
				controller.abort(error)
			}
		}
	})()
	try {
		const result = await host.run({
			signal,
			maxSteps: options.maxSteps,
			...(options.keepAlive !== undefined ? { keepAlive: options.keepAlive } : {}),
			...(options.maxIdleMs !== undefined ? { maxIdleMs: options.maxIdleMs } : {}),
		})
		if (monitorFailure) throw monitorFailure
		return result
	} finally {
		monitorStop.abort()
		await monitor
	}
}
