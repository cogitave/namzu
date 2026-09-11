import { setTimeout as sleep } from 'node:timers/promises'
import {
	ResidentConflictError,
	type ResidentDecision,
	type ResidentState,
	type ResidentStore,
} from './store.js'

/** @experimental Developer-owned step; bind providers, tools and budgets in the host. */
export type ResidentStep = (state: ResidentState, signal: AbortSignal) => Promise<ResidentDecision>

/** @experimental No model is invoked for an idle, terminal or unresolved resident. */
export type ResidentStepResult =
	| { status: 'settled'; state: ResidentState }
	| {
			status: 'idle'
			reason: 'not-due' | 'terminal' | 'unresolved' | 'contended'
			state: ResidentState
	  }

/** @experimental A failed/aborted callback leaves its durable claim unresolved. */
export async function stepResident(
	store: ResidentStore,
	step: ResidentStep,
	signal: AbortSignal,
	now: () => number = Date.now,
): Promise<ResidentStepResult> {
	signal.throwIfAborted()
	const state = await store.read()
	if (!state) throw new Error('Create the resident before running it.')
	if (state.phase === 'running') return { status: 'idle', reason: 'unresolved', state }
	if (state.phase !== 'waiting') return { status: 'idle', reason: 'terminal', state }
	if (state.wakeAt === null || state.wakeAt > now())
		return { status: 'idle', reason: 'not-due', state }
	let claim: ResidentState
	try {
		claim = await store.claim(state, now())
	} catch (error) {
		if (!(error instanceof ResidentConflictError)) throw error
		return {
			status: 'idle',
			reason: 'contended',
			state: (await store.read()) ?? state,
		}
	}
	signal.throwIfAborted()
	const decision = await step(claim, signal)
	signal.throwIfAborted()
	return {
		status: 'settled',
		state: await store.settle(claim, decision, now()),
	}
}

/** @experimental Bounded local driver; not a daemon, process recovery service or notification transport. */
export interface ResidentLoopOptions {
	readonly store: ResidentStore
	readonly step: ResidentStep
	readonly signal: AbortSignal
	/** Required finite admission cap for this invocation, independent of provider token limits. */
	readonly maxSteps: number
	/** Maximum single idle wait, default 60 seconds. Longer waits return control to the host. */
	readonly maxIdleMs?: number
}

/**
 * @experimental Continue a pursuit without a new user message. Null wake times
 * and terminal states stop immediately; cancellation also interrupts idle waits.
 * An abort cannot undo callback effects or forcibly stop a callback ignoring its signal.
 */
export async function runResident(options: ResidentLoopOptions): Promise<ResidentStepResult> {
	const maxIdleMs = options.maxIdleMs ?? 60_000
	if (
		!Number.isSafeInteger(options.maxSteps) ||
		options.maxSteps < 1 ||
		!Number.isSafeInteger(maxIdleMs) ||
		maxIdleMs < 0 ||
		maxIdleMs > 2_147_483_647
	) {
		throw new TypeError(
			'Resident loop requires positive finite maxSteps and bounded nonnegative maxIdleMs.',
		)
	}
	let admitted = 0
	while (true) {
		const result = await stepResident(options.store, options.step, options.signal)
		if (result.status === 'settled') admitted++
		if (admitted >= options.maxSteps) return result
		const { state } = result
		if (
			state.phase !== 'waiting' ||
			state.wakeAt === null ||
			(result.status === 'idle' && result.reason !== 'not-due')
		)
			return result
		const delay = Math.max(0, state.wakeAt - Date.now())
		if (delay > maxIdleMs) return result
		await sleep(Math.max(1, delay), undefined, { signal: options.signal })
	}
}
