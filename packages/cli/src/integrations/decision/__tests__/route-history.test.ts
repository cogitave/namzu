import { describe, expect, it } from 'vitest'
import type { RoutingConfig } from '../../../config/schema.js'
import { createRouteHistory, failedOnItsModel } from '../route-history.js'
import { type RouteTier, routeModel } from '../routing.js'

const DEFAULT = { provider: 'anthropic', model: 'sonnet' }
const FAST = { provider: 'ollama', model: 'gemma3:1b' }
const BIG = { provider: 'anthropic', model: 'opus' }
const config: RoutingConfig = { default: DEFAULT, tiers: { fast: FAST, big: BIG } }

/** What the session does around one turn: take the flag, route, remember where it ran. */
async function routedTurn(
	history: ReturnType<typeof createRouteHistory>,
	conversation: string,
	pickedTier: RouteTier,
): Promise<RouteTier> {
	const failedOn = history.take(conversation)
	const routed = await routeModel(
		{
			task: 'rename a file',
			config,
			features: failedOn ? { previousTurnFailedOnTier: failedOn } : {},
		},
		{},
	)
	// With no decision model the router answers the default tier; a turn that
	// the decision model sent elsewhere is stood in for by `pickedTier`.
	const tier = failedOn ? routed.tier : pickedTier
	history.ran(conversation, tier)
	return tier
}

const providerError = { kind: 'error' as const, providerError: { code: 'x' } }

describe('failedOnItsModel', () => {
	it('counts a provider error and a turn that stopped on an error', () => {
		expect(failedOnItsModel(providerError, false)).toBe(true)
		expect(failedOnItsModel({ kind: 'error', failure: { code: 'provider_error' } }, false)).toBe(
			true,
		)
		expect(failedOnItsModel({ kind: 'done', stopReason: 'error' }, false)).toBe(true)
	})

	it('does not count an interrupt, a refusal of permission, or a stop that is not a model fault', () => {
		expect(failedOnItsModel(providerError, true)).toBe(false)
		for (const stopReason of [
			'end_turn',
			'cancelled',
			'plan_rejected',
			'step_refused',
			'refused',
			'max_iterations',
			'timeout',
			'input_guardrail',
			'output_guardrail',
		] as const) {
			expect(failedOnItsModel({ kind: 'done', stopReason }, false)).toBe(false)
		}
		expect(failedOnItsModel({ kind: 'done' }, false)).toBe(false)
	})

	it('does not count an error that never reached a model', () => {
		expect(failedOnItsModel({ kind: 'error' }, false)).toBe(false)
		expect(failedOnItsModel({ kind: 'error', failure: { code: 'validation_error' } }, false)).toBe(
			false,
		)
		expect(failedOnItsModel({ ...providerError, turnInProgress: {} }, false)).toBe(false)
	})
})

describe('route history', () => {
	it('sends the turn after a failed fast turn to default', async () => {
		const history = createRouteHistory()
		await routedTurn(history, 'c1', 'fast')
		history.settle('c1', true)
		expect(await routedTurn(history, 'c1', 'fast')).toBe('default')
	})

	it('sends the turn after a failed default turn to big', async () => {
		const history = createRouteHistory()
		await routedTurn(history, 'c1', 'default')
		history.settle('c1', true)
		expect(await routedTurn(history, 'c1', 'fast')).toBe('big')
	})

	it('does not escalate after an interrupted turn', async () => {
		const history = createRouteHistory()
		await routedTurn(history, 'c1', 'fast')
		history.settle('c1', failedOnItsModel({ kind: 'done', stopReason: 'cancelled' }, false))
		expect(await routedTurn(history, 'c1', 'fast')).toBe('fast')
	})

	it('escalates one turn only: the flag is gone after one use', async () => {
		const history = createRouteHistory()
		await routedTurn(history, 'c1', 'fast')
		history.settle('c1', true)
		expect(await routedTurn(history, 'c1', 'fast')).toBe('default')
		expect(await routedTurn(history, 'c1', 'fast')).toBe('fast')
	})

	it('does not survive a successful turn', async () => {
		const history = createRouteHistory()
		await routedTurn(history, 'c1', 'fast')
		history.settle('c1', true)
		await routedTurn(history, 'c1', 'fast') // escalated, runs on default
		history.settle('c1', false)
		expect(await routedTurn(history, 'c1', 'fast')).toBe('fast')
	})

	it('does not leak into another conversation', async () => {
		const history = createRouteHistory()
		await routedTurn(history, 'c1', 'fast')
		history.settle('c1', true)
		expect(await routedTurn(history, 'c2', 'fast')).toBe('fast')
		// The other conversation's own flag is untouched by it.
		expect(history.take('c1')).toBe('fast')
	})

	it('ignores a failure for a turn that was never routed', () => {
		const history = createRouteHistory()
		history.settle('c1', true)
		expect(history.take('c1')).toBeUndefined()
	})

	it('drops the memory when a turn ran that routing did not choose', async () => {
		const history = createRouteHistory()
		await routedTurn(history, 'c1', 'default')
		history.settle('c1', true)
		history.forget('c1')
		expect(history.take('c1')).toBeUndefined()
	})

	it('reads a flag even when auto is off, so a later auto turn is not escalated by it', () => {
		const history = createRouteHistory()
		history.ran('c1', 'fast')
		history.settle('c1', true)
		expect(history.take('c1')).toBe('fast') // the call that finds auto off still consumes it
		expect(history.take('c1')).toBeUndefined()
	})
})
