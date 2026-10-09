import { describe, expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
import {
	dateSeparatorFlags,
	dateSeparatorLabel,
	elapsedLabel,
	terminalNotice,
	toolGroupLabel,
	transcriptTurns,
	turnDurationMs,
} from './transcript-layout.js'

it('keeps commentary, tools and thoughts in admitted order above the answer', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Review',
	})
	const update = (value: Parameters<typeof applyEvent>[1] & { kind: 'update' }) => {
		thread = applyEvent(thread, value)
	}
	update({
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: {
			kind: 'agent_message_chunk',
			text: 'Inspecting',
			phase: 'commentary',
			messageId: 'm1',
		},
	})
	update({
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: {
			kind: 'tool_call',
			toolCallId: 't',
			title: 'exec',
			status: 'completed',
			view: { kind: 'terminal', command: 'pwd', output: 'workspace' },
		},
	})
	update({
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: { kind: 'agent_thought_chunk', text: 'Compare results' },
	})
	update({
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: {
			kind: 'agent_message_chunk',
			text: 'Reviewed',
			phase: 'final_answer',
			messageId: 'm2',
		},
	})
	const [turn] = transcriptTurns(thread)
	expect(turn?.activity.map((entry) => entry.kind)).toEqual(['message', 'tool', 'reasoning'])
	expect(
		turn?.answer.map((entry) =>
			entry.kind === 'message' ? thread.messages[entry.index]?.text : entry.kind,
		),
	).toEqual(['Reviewed'])
})

it('keeps a same-turn live input after prior work and before its following answer', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Original request',
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'agent_message_chunk',
			text: 'Prior commentary',
			phase: 'commentary',
			messageId: 'before',
		},
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call',
			toolCallId: 'prior-tool',
			title: 'Check workspace',
			status: 'completed',
			view: { kind: 'terminal', command: 'pwd', output: 'workspace' },
		},
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 's',
		inputId: 'live',
		prompt: 'Steer now',
		status: 'unknown',
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'agent_message_chunk', text: 'Following answer', messageId: 'after' },
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 's',
		inputId: 'live',
		prompt: 'Steer now',
		status: 'delivered',
	})
	const turn = transcriptTurns(thread)[0]
	expect(
		turn?.segments.map((segment) => ({
			user: segment.user.map((entry) =>
				entry.kind === 'message' ? thread.messages[entry.index]?.text : '',
			),
			activity: segment.activity.map((entry) =>
				entry.kind === 'message' ? thread.messages[entry.index]?.text : entry.kind,
			),
			answer: segment.answer.map((entry) =>
				entry.kind === 'message' ? thread.messages[entry.index]?.text : entry.kind,
			),
		})),
	).toEqual([
		{ user: ['Original request'], activity: ['Prior commentary', 'tool'], answer: [] },
		{ user: ['Steer now'], activity: [], answer: ['Following answer'] },
	])
	expect(thread.turn).toBe(1)
})

it('does not move an early final part across later tool events or invent work in text-only restored history', () => {
	const thread = emptyThread()
	thread.messages = [
		{ role: 'user', text: 'Check' },
		{ role: 'assistant', text: 'Early answer', phase: 'final_answer' },
		{ role: 'assistant', text: 'Updated answer' },
	]
	thread.tools['1:tool'] = {
		kind: 'tool_call',
		toolCallId: 'tool',
		title: 'Read document',
		status: 'completed',
		view: { kind: 'terminal', output: 'Actual document' },
	}
	thread.timeline = [
		{ kind: 'message', index: 0, turn: 1 },
		{ kind: 'message', index: 1, turn: 1 },
		{ kind: 'tool', id: '1:tool', turn: 1 },
		{ kind: 'message', index: 2, turn: 1 },
	]
	expect(transcriptTurns(thread)[0]?.activity.map((entry) => entry.kind)).toEqual([
		'message',
		'tool',
	])
	thread.timeline = thread.timeline.filter((entry) => entry.kind === 'message')
	expect(transcriptTurns(thread)[0]?.activity).toEqual([])
	expect(transcriptTurns(thread)[0]?.answer).toHaveLength(2)
})

it('keeps elapsed labels and pause/limit notices tied to actual reported metadata', () => {
	expect(elapsedLabel(65000)).toBe('1m 5s')
	expect(elapsedLabel(3600000)).toBe('1h 0m')
	expect(elapsedLabel(-100)).toBe('0s')
	expect(terminalNotice('end_turn')).toBeUndefined()
	expect(terminalNotice('paused')).toContain('Paused')
	expect(terminalNotice('abandoned')).toBe('You continued without this reply.')
	expect(terminalNotice('cancelled')).toContain('Stopped')
	expect(terminalNotice('output_guardrail')).toContain('safety rule')
})

it('does not label failed or interrupted command groups as completed work', () => {
	const tool = {
		kind: 'tool_call' as const,
		toolCallId: 't',
		title: 'exec',
		status: 'completed' as const,
		view: { kind: 'terminal' as const, command: 'Check', output: '' },
	}
	expect(toolGroupLabel([tool, { ...tool, status: 'pending' }], false)).toBe(
		'Commands · interrupted',
	)
	expect(toolGroupLabel([tool, { ...tool, status: 'failed' }], false)).toBe('Commands · failed')
	expect(toolGroupLabel([tool, { ...tool, status: 'pending' }], true)).toBe('Running commands')
	expect(toolGroupLabel([tool, tool], false)).toBe('Ran commands')
})

it('groups only proved earlier-message checks under a plain label', () => {
	const lookup = {
		kind: 'tool_call' as const,
		toolCallId: 'query',
		title: 'search_conversation',
		status: 'completed' as const,
		view: { kind: 'terminal' as const, output: '' },
	}
	expect(toolGroupLabel([lookup, lookup], false, ['completed', 'completed'])).toBe(
		'Checked earlier messages',
	)
	expect(toolGroupLabel([lookup, lookup], true, ['completed', 'running'])).toBe(
		'Checking earlier messages',
	)
	expect(toolGroupLabel([lookup, lookup], true, ['completed', 'waiting'])).toBe(
		'Waiting to check earlier messages',
	)
	expect(toolGroupLabel([lookup, lookup], false, ['completed', 'failed'])).toBe(
		'Some earlier-message checks did not finish',
	)
})

it('classifies actual stop metadata without promising unsupported recovery or blaming the user', () => {
	expect(terminalNotice('stop_condition')).toBeUndefined()
	for (const reason of ['cancelled', 'canceled', 'aborted'])
		expect(terminalNotice(reason)).toBe('Stopped.')
	for (const reason of ['paused', 'timeout'])
		expect(terminalNotice(reason)).not.toMatch(/continue|retry/i)
	expect(terminalNotice('step_refused')).toContain('execution policy')
	expect(terminalNotice('step_refused')).not.toContain('approved')
	expect(terminalNotice('cost_unmeasurable')).toContain('could not be checked')
	expect(terminalNotice('answer_rejected')).toContain('response')
	expect(terminalNotice('plan_rejected')).toContain('plan')
	expect(terminalNotice('max_iterations')).toContain('step limit')
})

it('does not infer command execution from terminal-shaped generic output', () => {
	const output = {
		kind: 'tool_call' as const,
		toolCallId: 'read',
		title: 'Read document',
		status: 'completed' as const,
		view: { kind: 'terminal' as const, output: 'Document contents' },
	}
	expect(toolGroupLabel([output, output], false, ['completed', 'completed'])).toBe(
		'Actions completed',
	)
	expect(
		toolGroupLabel([output, { ...output, status: 'pending' }], true, ['completed', 'waiting']),
	).toBe('Actions · 1 completed, 1 waiting for approval')
})

it('keeps a real answer visible when later commentary or reasoning has no public content', () => {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Check' })
	for (const update of [
		{
			kind: 'agent_message' as const,
			status: 'completed' as const,
			messageId: 'final',
			content: 'A real final reply',
			textParts: [{ id: 'final-part', phase: 'final_answer' as const, text: 'A real final reply' }],
			stopReason: 'end_turn' as const,
		},
		{
			kind: 'agent_message_chunk' as const,
			messageId: 'empty-update',
			text: '\n  ',
			phase: 'commentary' as const,
		},
		{ kind: 'agent_thought_chunk' as const, text: ' \n\t' },
	])
		thread = applyEvent(thread, { kind: 'update', sessionId: 's', projectId: 'p', update })
	const before = structuredClone(thread)
	const [turn] = transcriptTurns(thread)
	expect(turn?.activity).toEqual([])
	expect(
		turn?.answer.map((entry) =>
			entry.kind === 'message' ? thread.messages[entry.index]?.text : entry.kind,
		),
	).toEqual(['A real final reply'])
	expect(thread).toEqual(before)
})

describe('finished turn duration', () => {
	const timed = (turn: object, times: number[] = []) => {
		const thread = emptyThread()
		thread.turn = 1
		thread.turns[1] = turn
		times.forEach((at, index) => {
			thread.messages.push({ role: 'assistant', text: `m${index}`, time: { at, source: 'host' } })
			thread.timeline.push({ kind: 'message', index, turn: 1 })
		})
		return thread
	}
	it('prefers the host start and end, then the recorded duration', () => {
		expect(turnDurationMs(timed({ startedAt: 1000, endedAt: 5000 }), 1)).toBe(4000)
		expect(turnDurationMs(timed({ recordedDurationMs: 257000 }), 1)).toBe(257000)
	})
	it('falls back to the start and the last time seen in the turn', () => {
		expect(turnDurationMs(timed({ startedAt: 1000 }, [2000, 9000, 4000]), 1)).toBe(8000)
	})
	it('never invents one', () => {
		expect(turnDurationMs(timed({}, [2000, 9000]), 1)).toBeUndefined()
		expect(turnDurationMs(timed({ startedAt: 1000 }), 1)).toBeUndefined()
		expect(turnDurationMs(timed({ startedAt: 10000 }, [2000]), 1)).toBeUndefined()
		expect(turnDurationMs(emptyThread(), 1)).toBeUndefined()
	})
})

describe('date separators', () => {
	const t = (day: number, hour: number, minute = 0) =>
		new Date(2026, 7, day, hour, minute).getTime()
	it('starts at the first known time and then marks a new day or a gap over six hours', () => {
		expect(
			dateSeparatorFlags([t(6, 10), t(6, 10, 30), t(6, 16), t(6, 16, 1), t(6, 23, 59), t(7, 0, 1)]),
		).toEqual([true, false, false, false, true, true])
		expect(dateSeparatorFlags([t(6, 10), t(6, 16, 0)])).toEqual([true, false])
		expect(dateSeparatorFlags([t(6, 10), t(6, 16, 1)])).toEqual([true, true])
	})
	it('lets unknown times neither produce nor move a separator', () => {
		expect(dateSeparatorFlags([undefined, t(6, 10), undefined, t(6, 11), undefined])).toEqual([
			false,
			true,
			false,
			false,
			false,
		])
		expect(dateSeparatorFlags([undefined, undefined])).toEqual([false, false])
	})
	it('formats weekday, day, month and clock in the given locale', () => {
		expect(dateSeparatorLabel(t(6, 10, 6), 'en-GB')).toBe('Thu 6 Aug, 10:06')
		expect(dateSeparatorLabel(t(6, 10, 6), 'en-GB')).not.toContain('2026')
	})
})
