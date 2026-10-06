import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
import {
	elapsedLabel,
	terminalNotice,
	toolGroupLabel,
	transcriptTurns,
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
	expect(terminalNotice('cancelled')).toContain('Stopped')
	expect(terminalNotice('output_guardrail')).toContain('guardrail')
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

it('classifies actual stop metadata without promising unsupported recovery or blaming the user', () => {
	expect(terminalNotice('stop_condition')).toBeUndefined()
	for (const reason of ['cancelled', 'canceled', 'aborted'])
		expect(terminalNotice(reason)).toBe('Stopped.')
	for (const reason of ['paused', 'timeout'])
		expect(terminalNotice(reason)).not.toMatch(/continue|retry/i)
	expect(terminalNotice('step_refused')).toContain('execution policy')
	expect(terminalNotice('step_refused')).not.toContain('approved')
	expect(terminalNotice('cost_unmeasurable')).toContain('could not be measured')
	expect(terminalNotice('answer_rejected')).toContain('response')
	expect(terminalNotice('plan_rejected')).toContain('plan')
	expect(terminalNotice('max_iterations')).toContain('turn limit')
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
