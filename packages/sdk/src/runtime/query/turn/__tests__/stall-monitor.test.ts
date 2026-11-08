import { describe, expect, it } from 'vitest'

import {
	DEFAULT_MAX_REASONING_TOKENS,
	StallMonitor,
	callChangedState,
	reasoningCapChars,
} from '../stall-monitor.js'

describe('what counts as a change', () => {
	it('is a successful call that is not read-only and not the task list', () => {
		expect(callChangedState('edit', false, false)).toBe(true)
		expect(callChangedState('bash', undefined, false)).toBe(true)
		expect(callChangedState('read', true, false)).toBe(false)
		expect(callChangedState('edit', false, true)).toBe(false)
		expect(callChangedState('task_update', false, false)).toBe(false)
		expect(callChangedState('task_create', undefined, false)).toBe(false)
	})
})

describe('the per-step reasoning cap', () => {
	it('is on by default at medium effort and above, and off below', () => {
		const chars = DEFAULT_MAX_REASONING_TOKENS * 4
		expect(reasoningCapChars(undefined, 'high')).toBe(chars)
		expect(reasoningCapChars(undefined, 'medium')).toBe(chars)
		expect(reasoningCapChars(undefined, 'low')).toBeUndefined()
		expect(reasoningCapChars(undefined, undefined)).toBeUndefined()
	})

	it('is set, or removed with 0, by the host at any effort', () => {
		expect(reasoningCapChars({ maxTokens: 1000 }, 'low')).toBe(4000)
		expect(reasoningCapChars({ maxTokens: 0 }, 'high')).toBeUndefined()
	})
})

describe('the stall monitor', () => {
	const idle = { reasoningChars: 0, changedState: false }

	it('nudges after a run of steps that changed nothing, then forces an action step', () => {
		const monitor = new StallMonitor({ nudgeAfterSteps: 3, forceAfterSteps: 2 })
		expect(monitor.observe(idle).kind).toBe('none')
		expect(monitor.observe(idle).kind).toBe('none')
		expect(monitor.observe(idle).kind).toBe('nudge')
		expect(monitor.observe(idle).kind).toBe('none')
		expect(monitor.observe(idle).kind).toBe('force')
		// The count starts again after a force.
		expect(monitor.observe(idle).kind).toBe('none')
	})

	it('nudges on reasoning that piles up even in few steps', () => {
		const monitor = new StallMonitor({ nudgeAfterReasoningChars: 100 })
		expect(monitor.observe({ reasoningChars: 60, changedState: false }).kind).toBe('none')
		expect(monitor.observe({ reasoningChars: 60, changedState: false }).kind).toBe('nudge')
	})

	it('is reset by a change', () => {
		const monitor = new StallMonitor({ nudgeAfterSteps: 2 })
		monitor.observe(idle)
		expect(monitor.observe({ reasoningChars: 0, changedState: true }).kind).toBe('none')
		expect(monitor.observe(idle).kind).toBe('none')
		expect(monitor.observe(idle).kind).toBe('nudge')
	})
})
