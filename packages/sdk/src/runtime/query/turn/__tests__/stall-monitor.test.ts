import { describe, expect, it } from 'vitest'

import {
	ANSWER_NOW_MESSAGE,
	DEFAULT_MAX_REASONING_TOKENS,
	STALL_NUDGE_MESSAGE,
	STALL_REPORT_MESSAGE,
	StallMonitor,
	asksQuestion,
	callChangedState,
	callMadeProgress,
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

describe('the stall monitor in a turn that opened with a question', () => {
	const looked = { reasoningChars: 0, changedState: false, question: true }

	it('tells the model to answer after six steps, not twelve', () => {
		const monitor = new StallMonitor()
		for (let i = 0; i < 5; i++) expect(monitor.observe(looked).kind).toBe('none')
		const directive = monitor.observe(looked)
		expect(directive).toEqual({ kind: 'nudge', text: ANSWER_NOW_MESSAGE })
	})

	it('says it again instead of forcing a tool call', () => {
		const monitor = new StallMonitor({ answerAfterSteps: 2, forceAfterSteps: 2 })
		monitor.observe(looked)
		expect(monitor.observe(looked).kind).toBe('nudge')
		monitor.observe(looked)
		expect(monitor.observe(looked)).toEqual({ kind: 'nudge', text: ANSWER_NOW_MESSAGE })
	})

	it('leaves a turn without a question at twelve', () => {
		const idle = { reasoningChars: 0, changedState: false }
		const monitor = new StallMonitor()
		for (let i = 0; i < 11; i++) expect(monitor.observe(idle).kind).toBe('none')
		expect(monitor.observe(idle)).toEqual({ kind: 'nudge', text: STALL_NUDGE_MESSAGE })
	})
})

describe('what asks a question', () => {
	it('is a question mark in any script', () => {
		expect(asksQuestion('Bu sohbet neden pahalı oldu? Kuruş olarak söyle.')).toBe(true)
		expect(asksQuestion('なぜですか？')).toBe(true)
		expect(asksQuestion('Fix the failing test.')).toBe(false)
		expect(asksQuestion(undefined)).toBe(false)
	})

	it('is not a question mark inside a web address', () => {
		expect(
			asksQuestion(
				'Implement the client for https://api.example.com/v1/items?limit=10 and test it.',
			),
		).toBe(false)
	})

	it('is not a long brief that happens to ask something', () => {
		const brief = `Can you make the build pass? ${'Fix what fails and run the tests again. '.repeat(12)}`
		expect(asksQuestion(brief)).toBe(false)
		expect(asksQuestion('Can you make the build pass?')).toBe(true)
	})
})

describe('an agent that cannot change anything', () => {
	it('counts a successful read as progress, and nothing else', () => {
		expect(callMadeProgress('read', true, false, true)).toBe(true)
		expect(callMadeProgress('read', true, true, true)).toBe(false)
		expect(callMadeProgress('task_update', true, false, true)).toBe(false)
		expect(callMadeProgress('read', true, false, false)).toBe(false)
		expect(callMadeProgress('send_message', false, false, true)).toBe(false)
	})

	it('is told to report, not to edit, and is never forced', () => {
		const idle = { reasoningChars: 0, changedState: false, cannotChange: true }
		const monitor = new StallMonitor({ nudgeAfterSteps: 2, forceAfterSteps: 2 })
		monitor.observe(idle)
		expect(monitor.observe(idle)).toEqual({ kind: 'nudge', text: STALL_REPORT_MESSAGE })
		monitor.observe(idle)
		expect(monitor.observe(idle)).toEqual({ kind: 'nudge', text: STALL_REPORT_MESSAGE })
	})
})
