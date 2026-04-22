/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 6):
 *
 *   - Constructor filters OUT triggers with `enabled: false` + sorts
 *     by `priority` desc (higher first). Triggers without priority
 *     sort at 0.
 *   - `evaluate(state)` returns every trigger whose condition matches
 *     AND whose cooldown has elapsed. Order reflects the sorted
 *     trigger list.
 *   - Budget exhausted (callCount ≥ maxCallsPerRun) → evaluate returns [].
 *   - `recordFiring(id, iteration)` updates both `lastFiredMap` (for
 *     cooldown) and `callCount` (for budget).
 *   - Condition matchers:
 *     - `on_error`: matches iff state.lastError is set; if categories
 *       are given, requires at least one category substring match.
 *     - `on_iteration`: `state.iteration % everyN === 0`.
 *     - `on_context_percent`: `state.contextWindowPercent >= threshold`.
 *     - `on_tool_category`: `state.lastToolCategory` present + in
 *       `condition.categories`.
 *     - `on_cost_percent`: costBudgetPercent present + ≥ threshold.
 *     - `on_complexity`: totalToolCalls ≥ toolCallThreshold.
 *     - `custom`: calls the predicate.
 *   - Cooldown: trigger does NOT fire if `iteration - lastFired <
 *     cooldownIterations`. No cooldown → always eligible.
 *
 *   - **Purity:** evaluate() is pure relative to the advisory phase —
 *     it returns triggers; it does NOT inject messages or mutate
 *     external state. The injection happens in the advisory phase
 *     (runtime/query/iteration/phases/advisory.ts), which pushes a
 *     user message via `runMgr.pushMessage`. That file is OUT of
 *     scope for this test file (covered by the phase test).
 */

import { describe, expect, it, vi } from 'vitest'

import type { AdvisoryTrigger, TriggerEvaluationState } from '../types/advisory/index.js'

import { TriggerEvaluator } from './evaluator.js'

function trigger(id: string, overrides: Partial<AdvisoryTrigger> = {}): AdvisoryTrigger {
	return {
		id,
		condition: { type: 'on_iteration', everyN: 1 },
		...overrides,
	}
}

function state(overrides: Partial<TriggerEvaluationState> = {}): TriggerEvaluationState {
	return {
		iteration: 1,
		totalToolCalls: 0,
		totalTokens: 0,
		contextWindowPercent: 0,
		totalCostUsd: 0,
		costBudgetPercent: undefined,
		lastError: undefined,
		lastToolCategory: undefined,
		advisoryCallCount: 0,
		...overrides,
	}
}

describe('TriggerEvaluator — constructor', () => {
	it('filters out triggers with enabled: false', () => {
		const e = new TriggerEvaluator([trigger('a'), trigger('b', { enabled: false })])
		expect(e.evaluate(state()).map((t) => t.id)).toEqual(['a'])
	})

	it('sorts triggers by priority descending', () => {
		const e = new TriggerEvaluator([
			trigger('low', { priority: 1 }),
			trigger('high', { priority: 10 }),
			trigger('mid', { priority: 5 }),
		])
		expect(e.evaluate(state()).map((t) => t.id)).toEqual(['high', 'mid', 'low'])
	})
})

describe('TriggerEvaluator — budget', () => {
	it('returns [] when callCount >= maxCallsPerRun', () => {
		const e = new TriggerEvaluator([trigger('a')], { maxCallsPerRun: 1 })
		e.recordFiring('a', 1)
		expect(e.evaluate(state({ iteration: 2 }))).toEqual([])
	})

	it('ignores budget when maxCallsPerRun is not set', () => {
		const e = new TriggerEvaluator([trigger('a')])
		e.recordFiring('a', 1)
		e.recordFiring('a', 2)
		expect(e.evaluate(state({ iteration: 3 })).length).toBeGreaterThan(0)
	})
})

describe('TriggerEvaluator — cooldown', () => {
	it('blocks triggers in their cooldown window', () => {
		const e = new TriggerEvaluator([trigger('a', { cooldownIterations: 3 })])
		e.recordFiring('a', 1)
		expect(e.evaluate(state({ iteration: 2 })).map((t) => t.id)).toEqual([])
		expect(e.evaluate(state({ iteration: 3 })).map((t) => t.id)).toEqual([])
		expect(e.evaluate(state({ iteration: 4 })).map((t) => t.id)).toEqual(['a'])
	})

	it('always fires when no cooldown is configured', () => {
		const e = new TriggerEvaluator([trigger('a')])
		e.recordFiring('a', 1)
		expect(e.evaluate(state({ iteration: 2 })).map((t) => t.id)).toEqual(['a'])
	})
})

describe('TriggerEvaluator — condition matchers', () => {
	it('on_error: requires lastError to be set', () => {
		const e = new TriggerEvaluator([trigger('t', { condition: { type: 'on_error' } })])
		expect(e.evaluate(state())).toEqual([])
		expect(e.evaluate(state({ lastError: 'boom' })).map((t) => t.id)).toEqual(['t'])
	})

	it('on_error with categories: at least one substring match', () => {
		const e = new TriggerEvaluator([
			trigger('t', { condition: { type: 'on_error', categories: ['timeout', 'permission'] } }),
		])
		expect(e.evaluate(state({ lastError: 'Connection timeout' })).map((t) => t.id)).toEqual(['t'])
		expect(e.evaluate(state({ lastError: 'Syntax error' }))).toEqual([])
	})

	it('on_iteration: iteration % everyN === 0', () => {
		const e = new TriggerEvaluator([
			trigger('t', { condition: { type: 'on_iteration', everyN: 3 } }),
		])
		expect(e.evaluate(state({ iteration: 1 }))).toEqual([])
		expect(e.evaluate(state({ iteration: 3 })).map((t) => t.id)).toEqual(['t'])
		expect(e.evaluate(state({ iteration: 6 })).map((t) => t.id)).toEqual(['t'])
	})

	it('on_context_percent: contextWindowPercent >= threshold', () => {
		const e = new TriggerEvaluator([
			trigger('t', { condition: { type: 'on_context_percent', threshold: 80 } }),
		])
		expect(e.evaluate(state({ contextWindowPercent: 70 }))).toEqual([])
		expect(e.evaluate(state({ contextWindowPercent: 80 })).map((t) => t.id)).toEqual(['t'])
	})

	it('on_tool_category: lastToolCategory present + in categories list', () => {
		const e = new TriggerEvaluator([
			trigger('t', {
				condition: { type: 'on_tool_category', categories: ['network', 'filesystem'] },
			}),
		])
		expect(e.evaluate(state())).toEqual([])
		expect(e.evaluate(state({ lastToolCategory: 'other' }))).toEqual([])
		expect(e.evaluate(state({ lastToolCategory: 'network' })).map((t) => t.id)).toEqual(['t'])
	})

	it('on_cost_percent: costBudgetPercent present + >= threshold', () => {
		const e = new TriggerEvaluator([
			trigger('t', { condition: { type: 'on_cost_percent', threshold: 75 } }),
		])
		expect(e.evaluate(state())).toEqual([]) // undefined costBudgetPercent
		expect(e.evaluate(state({ costBudgetPercent: 50 }))).toEqual([])
		expect(e.evaluate(state({ costBudgetPercent: 80 })).map((t) => t.id)).toEqual(['t'])
	})

	it('on_complexity: totalToolCalls >= toolCallThreshold', () => {
		const e = new TriggerEvaluator([
			trigger('t', { condition: { type: 'on_complexity', toolCallThreshold: 10 } }),
		])
		expect(e.evaluate(state({ totalToolCalls: 5 }))).toEqual([])
		expect(e.evaluate(state({ totalToolCalls: 10 })).map((t) => t.id)).toEqual(['t'])
	})

	it('custom: calls the predicate with state', () => {
		const predicate = vi.fn(() => true)
		const e = new TriggerEvaluator([trigger('t', { condition: { type: 'custom', predicate } })])
		const s = state({ iteration: 42 })
		expect(e.evaluate(s).map((t) => t.id)).toEqual(['t'])
		expect(predicate).toHaveBeenCalledWith(s)
	})
})

describe('TriggerEvaluator — recordFiring', () => {
	it('updates lastFiredMap + callCount', () => {
		const e = new TriggerEvaluator([trigger('a', { cooldownIterations: 5 })], {
			maxCallsPerRun: 2,
		})
		e.recordFiring('a', 1)
		// cooldown active: no fires in iterations 2–5
		expect(e.evaluate(state({ iteration: 2 }))).toEqual([])
		// cooldown lifted at 6, but budget allows one more
		e.recordFiring('a', 6)
		// budget exhausted
		expect(e.evaluate(state({ iteration: 11 }))).toEqual([])
	})
})
