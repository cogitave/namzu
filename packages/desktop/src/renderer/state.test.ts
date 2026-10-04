import type { AcpSessionUpdate } from '@namzu/sdk'
import { expect, it } from 'vitest'
import {
	type ThreadState,
	applyEvent,
	emptyThread,
	restoreMessages,
	threadPhase,
} from '../shared/projection.js'
it('retains event admission order across streamed narration, tools, progress and later turns', () => {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Build' })
	const chunk = (text: string) => ({
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'agent_message_chunk' as const, text },
	})
	const tool = (status: 'pending' | 'completed') => ({
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call' as const,
			toolCallId: 'first',
			title: 'bash',
			status,
			view: { kind: 'generic' as const, label: 'Run tests' },
		},
	})
	thread = applyEvent(thread, chunk('I will test.'))
	thread = applyEvent(thread, tool('pending'))
	thread = applyEvent(thread, tool('completed'))
	thread = applyEvent(thread, chunk('Tests passed.'))
	thread = applyEvent(thread, chunk(' Ready.'))
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Continue' })
	thread = applyEvent(thread, chunk('Continuing.'))
	expect(thread.timeline).toEqual([
		{ kind: 'message', index: 0, turn: 1 },
		{ kind: 'message', index: 1, turn: 1 },
		{ kind: 'tool', id: '1:first', turn: 1 },
		{ kind: 'message', index: 2, turn: 1 },
		{ kind: 'message', index: 3, turn: 2 },
		{ kind: 'message', index: 4, turn: 2 },
	])
	expect(thread.messages.map((message) => message.text)).toEqual([
		'Build',
		'I will test.',
		'Tests passed. Ready.',
		'Continue',
		'Continuing.',
	])
})
it('restores text history in durable order without fabricating unavailable tool history', () => {
	const thread = restoreMessages(emptyThread(), [
		{ role: 'user', text: 'First' },
		{ role: 'assistant', text: 'Answer' },
		{ role: 'user', text: 'Next' },
	])
	expect(thread.timeline).toEqual([
		{ kind: 'message', index: 0, turn: 1 },
		{ kind: 'message', index: 1, turn: 1 },
		{ kind: 'message', index: 2, turn: 2 },
	])
	const continued = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'agent_message_chunk', text: 'Next answer' },
	})
	expect(continued.timeline.at(-1)).toEqual({ kind: 'message', index: 3, turn: 2 })
	expect(continued.tools).toEqual({})
})
it('keeps distinct tool receipts when a provider reuses a call ID on a later turn', () => {
	let thread = emptyThread()
	for (const title of ['First call', 'Second call']) {
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: title })
		for (const status of ['pending', 'completed'] as const)
			thread = applyEvent(thread, {
				kind: 'update',
				projectId: 'p',
				sessionId: 's',
				update: {
					kind: 'tool_call',
					toolCallId: 'call_0',
					title,
					status,
					view: { kind: 'generic', label: title },
				},
			})
	}
	expect(thread.timeline.filter((entry) => entry.kind === 'tool')).toEqual([
		{ kind: 'tool', id: '1:call_0', turn: 1 },
		{ kind: 'tool', id: '2:call_0', turn: 2 },
	])
	expect(thread.tools['1:call_0']?.title).toBe('First call')
	expect(thread.tools['2:call_0']?.title).toBe('Second call')
})
it('replays newer live updates onto a captured snapshot without duplicating included chunks', () => {
	const included = {
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		revision: 3,
		update: { kind: 'agent_message_chunk' as const, text: 'Already captured. ' },
	}
	let snapshot = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Continue',
		revision: 1,
	})
	snapshot = applyEvent(snapshot, {
		kind: 'state',
		sessionId: 's',
		running: true,
		queued: ['Pending'],
		revision: 2,
	})
	snapshot = applyEvent(snapshot, included)
	let restored = applyEvent(snapshot, included)
	restored = applyEvent(restored, {
		...included,
		revision: 4,
		update: { kind: 'agent_message_chunk', text: 'Arrived while opening.' },
	})
	restored = applyEvent(restored, {
		kind: 'state',
		sessionId: 's',
		running: false,
		queued: [],
		revision: 5,
	})
	expect(restored.messages.at(-1)?.text).toBe('Already captured. Arrived while opening.')
	expect(restored.running).toBe(false)
	expect(restored.queued).toEqual([])
	expect(
		applyEvent(restored, { kind: 'prompt', sessionId: 's', prompt: 'Stale', revision: 1 }),
	).toBe(restored)
})
it('keeps queued prompts out of the transcript until they actually start', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 'a',
		prompt: 'First request',
	})
	thread = applyEvent(thread, {
		kind: 'state',
		sessionId: 'a',
		running: true,
		queued: ['Next request'],
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 'a',
		update: { kind: 'agent_message_chunk', text: 'First answer' },
	})
	expect(thread.messages).toEqual([
		{ role: 'user', text: 'First request' },
		{ role: 'assistant', text: 'First answer' },
	])
	expect(thread.queued).toEqual(['Next request'])
	thread = applyEvent(thread, {
		kind: 'prompt',
		sessionId: 'a',
		prompt: 'Next request',
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 'a',
		update: { kind: 'agent_message_chunk', text: 'Next answer' },
	})
	expect(thread.messages.at(-1)?.text).toBe('Next answer')
	expect(thread.messages[1]?.text).toBe('First answer')
})
it('clears the answered approval and retains other pending questions', () => {
	let thread = emptyThread()
	for (const id of ['a', 'b'])
		thread = applyEvent(thread, {
			kind: 'permission',
			request: { id, sessionId: 's', projectId: 'p', calls: [] },
		})
	thread = applyEvent(thread, {
		kind: 'permission-cleared',
		sessionId: 's',
		requestId: 'a',
	})
	expect(thread.permissions.map((permission) => permission.id)).toEqual(['b'])
})

it('preserves the tool presentation across progress and shows actual provider failure', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call',
			toolCallId: 't',
			title: 'plugin',
			status: 'pending',
			view: { kind: 'diff', path: 'a.txt', before: 'a', after: 'b' },
		},
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call',
			toolCallId: 't',
			title: 'plugin',
			status: 'pending',
			view: { kind: 'generic', label: 'plugin' },
			progress: { message: 'Saving', fraction: 0.5 },
		},
	})
	expect(thread.tools['0:t']?.view.kind).toBe('diff')
	expect(thread.tools['0:t']?.progress?.message).toBe('Saving')
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'turn_ended',
			stopReason: 'error',
			error: 'The provider returned 503',
		},
	})
	expect(thread.error).toBe('The provider returned 503')
})

it('keeps interrupted tool history without animating it as work in a later turn', () => {
	const state = (running: boolean) => ({
		kind: 'state' as const,
		sessionId: 's',
		running,
		queued: [],
	})
	const tool = (id: string, status: 'pending' | 'completed') => ({
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call' as const,
			toolCallId: id,
			title: 'bash',
			status,
			view: { kind: 'generic' as const, label: 'bash' },
		},
	})
	let thread = applyEvent(emptyThread(), state(true))
	thread = applyEvent(thread, tool('interrupted', 'pending'))
	expect(thread.activeToolIds).toEqual(['0:interrupted'])
	thread = applyEvent(thread, state(false))
	expect(thread.activeToolIds).toEqual([])
	expect(thread.tools['0:interrupted']?.status).toBe('pending')
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Continue' })
	thread = applyEvent(thread, state(true))
	thread = applyEvent(thread, tool('new', 'pending'))
	expect(thread.activeToolIds).toEqual(['1:new'])
	thread = applyEvent(thread, tool('new', 'completed'))
	expect(thread.activeToolIds).toEqual([])
	thread = applyEvent(thread, tool('aborted', 'pending'))
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'turn_ended', stopReason: 'cancelled' },
	})
	expect(thread.activeToolIds).toEqual([])
	expect(Object.keys(thread.tools)).toEqual(['0:interrupted', '1:new', '1:aborted'])
})

function update(thread: ThreadState, value: AcpSessionUpdate, at?: number): ThreadState {
	return applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: value,
		...(at === undefined ? {} : { at }),
	})
}
function running(thread = emptyThread()): ThreadState {
	return applyEvent(thread, { kind: 'state', sessionId: 's', running: true, queued: [] })
}
function thought(status: 'pending' | 'completed', blockId = 'message:0'): AcpSessionUpdate {
	return { kind: 'agent_thought', status, messageId: 'message', turnId: 'native-turn', blockId }
}
function call(id: string, status: 'pending' | 'completed'): AcpSessionUpdate {
	return {
		kind: 'tool_call',
		toolCallId: id,
		status,
		title: id,
		view: { kind: 'generic', label: id },
	}
}

it('ends the live waiting phase at terminal settlement while retaining the owned pending request', () => {
	let thread = running()
	thread = applyEvent(thread, {
		kind: 'permission',
		request: { id: 'approval', sessionId: 's', projectId: 'p', calls: [] },
	})
	expect(threadPhase(thread)).toBe('waiting')
	thread = update(thread, { kind: 'turn_ended', stopReason: 'cancelled', reason: 'paused' })
	expect(thread.running).toBe(true)
	expect(thread.permissions.map((request) => request.id)).toEqual(['approval'])
	expect(threadPhase(thread)).toBe('idle')
	thread = applyEvent(thread, { kind: 'state', sessionId: 's', running: false, queued: [] })
	expect(threadPhase(thread)).toBe('idle')
	thread = applyEvent(thread, { kind: 'permission-cleared', sessionId: 's', requestId: 'approval' })
	expect(thread.permissions).toEqual([])
})

it('orders readable and redacted reasoning at actual boundaries and retains it across later prompts', () => {
	let thread = running(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Inspect' }),
	)
	thread = update(thread, thought('pending'))
	thread = update(thread, {
		kind: 'agent_thought_chunk',
		messageId: 'message',
		turnId: 'native-turn',
		blockId: 'message:0',
		text: 'Check ',
	})
	thread = update(thread, {
		kind: 'agent_thought_chunk',
		messageId: 'message',
		turnId: 'native-turn',
		blockId: 'message:0',
		text: 'the source.',
	})
	thread = update(thread, thought('completed'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'narration',
		turnId: 'native-turn',
		text: 'I will inspect it.',
		phase: 'commentary',
	})
	thread = update(thread, call('read', 'pending'))
	thread = update(thread, call('read', 'completed'))
	thread = update(thread, thought('pending', 'message:1'))
	thread = update(thread, thought('completed', 'message:1'))
	expect(thread.timeline.map((entry) => entry.kind)).toEqual([
		'message',
		'reasoning',
		'message',
		'tool',
		'reasoning',
	])
	expect(thread.reasoning['1:message:0']).toEqual({
		text: 'Check the source.',
		status: 'completed',
		turn: 1,
		messageId: 'message',
		blockId: 'message:0',
	})
	expect(thread.reasoning['1:message:1']?.text).toBe('')
	expect(thread.reasoning['1:message:1']?.status).toBe('completed')
	const priorReasoning = thread.reasoning
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Continue' })
	expect(thread.reasoning).toBe(priorReasoning)
	expect(thread.activeReasoningId).toBeUndefined()
	expect(threadPhase(thread)).toBe('working')
	thread = update(thread, {
		kind: 'agent_thought',
		status: 'pending',
		messageId: 'message',
		blockId: 'message:0',
		turnId: 'second-turn',
	})
	expect(Object.keys(thread.reasoning)).toEqual(['1:message:0', '1:message:1', '2:message:0'])
})

it('uses waiting, concurrent tools and actual reasoning phase before responding or generic work', () => {
	let thread = running()
	expect(threadPhase(thread)).toBe('working')
	thread = update(thread, thought('pending'))
	expect(threadPhase(thread)).toBe('thinking')
	thread = update(thread, thought('completed'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'reply',
		turnId: 'native-turn',
		text: 'Working on it.',
	})
	expect(threadPhase(thread)).toBe('responding')
	thread = update(thread, call('first', 'pending'))
	thread = update(thread, call('second', 'pending'))
	expect(threadPhase(thread)).toBe('tools')
	thread = applyEvent(thread, {
		kind: 'permission',
		request: { id: 'approval', sessionId: 's', projectId: 'p', calls: [] },
	})
	expect(threadPhase(thread)).toBe('waiting')
	thread = applyEvent(thread, { kind: 'permission-cleared', sessionId: 's', requestId: 'approval' })
	thread = update(thread, call('second', 'completed'))
	expect(thread.activeToolIds).toEqual(['0:first'])
	expect(threadPhase(thread)).toBe('tools')
	thread = update(thread, call('first', 'completed'))
	expect(threadPhase(thread)).toBe('working')
	thread = update(thread, thought('pending', 'message:1'))
	expect(threadPhase(thread)).toBe('thinking')
	thread = update(thread, {
		kind: 'turn_ended',
		stopReason: 'cancelled',
		reason: 'paused',
		turnId: 'native-turn',
	})
	expect(threadPhase(thread)).toBe('idle')
	expect(thread.reasoning['0:message:1']?.status).toBe('pending')
})

it('corrects public message parts by real identity without duplicating rows after intervening activity', () => {
	let thread = running()
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'm',
		textPart: { id: 'comment', phase: 'commentary' },
		text: 'Draft plan',
	})
	thread = update(thread, call('read', 'pending'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'm',
		textPart: { id: 'final', phase: 'final_answer' },
		text: 'Old answer',
	})
	thread = update(thread, {
		kind: 'agent_message',
		status: 'completed',
		messageId: 'm',
		stopReason: 'end_turn',
		content: 'Correct answer',
		textParts: [
			{ id: 'comment', phase: 'commentary', text: 'Correct plan' },
			{ id: 'final', phase: 'final_answer', text: 'Correct answer' },
		],
	})
	expect(thread.timeline).toEqual([
		{ kind: 'message', index: 0, turn: 0 },
		{ kind: 'tool', id: '0:read', turn: 0 },
		{ kind: 'message', index: 1, turn: 0 },
	])
	expect(
		thread.messages.map((message) => [
			message.messageId,
			message.textPartId,
			message.phase,
			message.text,
			message.status,
		]),
	).toEqual([
		['m', 'comment', 'commentary', 'Correct plan', 'completed'],
		['m', 'final', 'final_answer', 'Correct answer', 'completed'],
	])
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'm',
		textPart: { id: 'final', phase: 'final_answer' },
		text: ' stale tail',
	})
	expect(thread.messages[1]?.text).toBe('Correct answer')
})

it('removes superseded streamed parts and remaps indexes while retaining tool and reasoning order', () => {
	let thread = emptyThread()
	thread = update(thread, { kind: 'agent_message_chunk', messageId: 'm', text: 'Old aggregate' })
	thread = update(thread, thought('pending'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'other',
		text: 'Other narration',
	})
	thread = update(thread, call('read', 'pending'))
	thread = update(thread, {
		kind: 'agent_message',
		status: 'completed',
		messageId: 'm',
		stopReason: 'end_turn',
		textParts: [{ id: 'part', phase: 'final_answer', text: 'Final text' }],
	})
	expect(thread.messages.map((message) => message.text)).toEqual(['Final text', 'Other narration'])
	expect(thread.timeline).toEqual([
		{ kind: 'message', index: 0, turn: 0 },
		{ kind: 'reasoning', id: '0:message:0', turn: 0 },
		{ kind: 'message', index: 1, turn: 0 },
		{ kind: 'tool', id: '0:read', turn: 0 },
	])
})

it('clears rejected final output from an authoritative empty result and retains commentary and actual work', () => {
	let thread = running()
	thread = update(thread, thought('pending'))
	thread = update(thread, thought('completed'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'comment',
		text: 'I will check.',
		phase: 'commentary',
	})
	thread = update(thread, call('check', 'pending'))
	thread = update(thread, call('check', 'completed'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'answer',
		textPart: { id: 'answer-part', phase: 'final_answer' },
		text: 'Rejected answer',
	})
	thread = update(thread, {
		kind: 'agent_message',
		status: 'completed',
		messageId: 'answer',
		stopReason: 'end_turn',
		content: 'Rejected answer',
		textParts: [{ id: 'answer-part', phase: 'final_answer', text: 'Rejected answer' }],
	})
	thread = update(thread, {
		kind: 'turn_ended',
		turnId: 'native-turn',
		messageId: 'answer',
		stopReason: 'refused',
		reason: 'output_guardrail',
		result: '',
	})
	expect(thread.messages.map((message) => message.text)).toEqual(['I will check.'])
	expect(thread.timeline.map((entry) => entry.kind)).toEqual(['reasoning', 'message', 'tool'])
	expect(thread.reasoning['0:message:0']?.text).toBe('')
	expect(thread.turns[0]).toMatchObject({
		turnId: 'native-turn',
		stopReason: 'refused',
		reason: 'output_guardrail',
		result: '',
	})
	expect(threadPhase(thread)).toBe('idle')
})

it('applies settled correction to the exact result message instead of later narration', () => {
	let thread = emptyThread()
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'answer',
		text: 'Draft answer',
	})
	thread = update(thread, call('late-tool', 'completed'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'later',
		text: 'Later commentary',
		phase: 'commentary',
	})
	thread = update(thread, {
		kind: 'turn_ended',
		messageId: 'answer',
		stopReason: 'end_turn',
		result: 'Rewritten answer',
	})
	expect(thread.messages.map((message) => message.text)).toEqual([
		'Rewritten answer',
		'Later commentary',
	])
	expect(thread.messages[0]?.messageId).toBe('answer')
	expect(thread.messages[1]?.phase).toBe('commentary')
	thread = update(thread, {
		kind: 'turn_ended',
		messageId: 'never-streamed',
		stopReason: 'end_turn',
		result: 'Host-settled output',
	})
	expect(thread.messages.at(-1)).toMatchObject({
		messageId: 'never-streamed',
		text: 'Host-settled output',
	})
})

it('does not let known old native turns or mismatched unknown turns change current active phase', () => {
	let thread = running(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'First' }),
	)
	thread = update(thread, thought('pending'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'old',
		turnId: 'native-turn',
		text: 'Old draft',
	})
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Next' })
	thread = update(thread, {
		kind: 'agent_thought',
		status: 'pending',
		messageId: 'new',
		turnId: 'new-turn',
		blockId: 'new:0',
	})
	thread = update(thread, {
		kind: 'agent_message',
		status: 'completed',
		turnId: 'native-turn',
		messageId: 'old',
		stopReason: 'end_turn',
		content: 'Old correction',
	})
	thread = update(
		thread,
		{ kind: 'turn_ended', turnId: 'native-turn', stopReason: 'end_turn', result: 'Old correction' },
		200,
	)
	expect(thread.messages.find((message) => message.messageId === 'old')?.text).toBe(
		'Old correction',
	)
	expect(thread.turns[1]?.endedAt).toBe(200)
	expect(thread.stopReason).toBeUndefined()
	expect(thread.activeReasoningId).toBe('2:new:0')
	expect(threadPhase(thread)).toBe('thinking')
	const before = thread
	thread = update(thread, {
		kind: 'turn_ended',
		turnId: 'unbound-foreign-turn',
		stopReason: 'error',
		result: 'Wrong turn',
	})
	expect(thread).toBe(before)
})

it('replays reasoning revisions once and retains host admission/end timestamps across snapshots', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Inspect',
		at: 1000,
		revision: 1,
	})
	thread = running(thread)
	const pending = {
		kind: 'update' as const,
		sessionId: 's',
		projectId: 'p',
		revision: 2,
		update: thought('pending'),
	}
	thread = applyEvent(thread, pending)
	const chunk = {
		...pending,
		revision: 3,
		update: {
			kind: 'agent_thought_chunk' as const,
			messageId: 'message',
			turnId: 'native-turn',
			blockId: 'message:0',
			text: 'Public summary',
		},
	}
	const captured = applyEvent(thread, chunk)
	thread = applyEvent(captured, chunk)
	thread = applyEvent(thread, { ...pending, revision: 4, update: thought('completed') })
	thread = applyEvent(thread, {
		...pending,
		revision: 5,
		at: 4500,
		update: {
			kind: 'turn_ended',
			turnId: 'native-turn',
			stopReason: 'cancelled',
			reason: 'paused',
		},
	})
	thread = applyEvent(thread, {
		...pending,
		revision: 6,
		at: 9900,
		update: {
			kind: 'turn_ended',
			turnId: 'native-turn',
			stopReason: 'cancelled',
			reason: 'paused',
		},
	})
	expect(thread.reasoning['1:message:0']?.text).toBe('Public summary')
	expect(thread.timeline.filter((entry) => entry.kind === 'reasoning')).toHaveLength(1)
	expect(thread.turns[1]).toEqual({
		startedAt: 1000,
		endedAt: 4500,
		turnId: 'native-turn',
		stopReason: 'cancelled',
		reason: 'paused',
	})
	expect(applyEvent(thread, chunk)).toBe(thread)
})

it('keeps cold durable text honest without reconstructing unavailable tools, reasoning or time', () => {
	let thread = running()
	thread = update(thread, thought('pending'))
	thread = update(thread, call('read', 'pending'))
	thread = update(
		thread,
		{ kind: 'turn_ended', stopReason: 'cancelled', turnId: 'native-turn' },
		50,
	)
	thread = restoreMessages(thread, [
		{ role: 'user', text: 'Earlier' },
		{ role: 'assistant', text: 'Saved answer', messageId: 'saved', phase: 'final_answer' },
	])
	expect(thread.timeline.map((entry) => entry.kind)).toEqual(['message', 'message'])
	expect(thread.tools).toEqual({})
	expect(thread.reasoning).toEqual({})
	expect(thread.turns).toEqual({})
	expect(thread.activeReasoningId).toBeUndefined()
	expect(thread.messages[1]).toMatchObject({ messageId: 'saved', phase: 'final_answer' })
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Next', at: Number.NaN })
	thread = update(thread, { kind: 'turn_ended', stopReason: 'cancelled' })
	expect(thread.turns[2]).toEqual({ stopReason: 'cancelled' })
})

it('segments legacy reasoning around activity and does not keep its old pending phase over an answer', () => {
	let thread = running()
	thread = update(thread, { kind: 'agent_thought_chunk', text: 'First ' })
	thread = update(thread, { kind: 'agent_thought_chunk', text: 'summary.' })
	thread = update(thread, call('read', 'completed'))
	thread = update(thread, { kind: 'agent_thought_chunk', text: 'Second summary.' })
	expect(thread.timeline.map((entry) => entry.kind)).toEqual(['reasoning', 'tool', 'reasoning'])
	expect(Object.values(thread.reasoning).map((segment) => segment.text)).toEqual([
		'First summary.',
		'Second summary.',
	])
	thread = update(thread, { kind: 'agent_message_chunk', text: 'Answer.' })
	expect(threadPhase(thread)).toBe('responding')
})

it('does not reopen a completed tool or lose its measured duration on delayed progress', () => {
	let thread = running()
	thread = update(thread, {
		...call('read', 'completed'),
		kind: 'tool_call',
		toolCallId: 'read',
		title: 'read',
		status: 'completed',
		view: { kind: 'generic', label: 'Done' },
		durationMs: 42,
	})
	thread = update(thread, {
		kind: 'tool_call',
		toolCallId: 'read',
		title: 'read',
		status: 'pending',
		view: { kind: 'generic', label: 'Read' },
		progress: { message: 'Late output' },
	})
	expect(thread.activeToolIds).toEqual([])
	expect(thread.tools['0:read']).toMatchObject({
		status: 'completed',
		durationMs: 42,
		view: { kind: 'generic', label: 'Done' },
	})
	expect(threadPhase(thread)).toBe('working')
})

it('retains received public text when a legacy completed message omits authoritative content', () => {
	let thread = emptyThread()
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'message',
		textPart: { id: 'comment', phase: 'commentary' },
		text: 'Public commentary',
	})
	thread = update(thread, call('read', 'completed'))
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'message',
		textPart: { id: 'answer', phase: 'final_answer' },
		text: 'Public answer',
	})
	thread = update(thread, {
		kind: 'agent_message',
		messageId: 'message',
		status: 'completed',
		stopReason: 'end_turn',
	})
	expect(thread.messages.map((message) => [message.text, message.phase, message.status])).toEqual([
		['Public commentary', 'commentary', 'completed'],
		['Public answer', 'final_answer', 'completed'],
	])
	expect(thread.timeline.map((entry) => entry.kind)).toEqual(['message', 'tool', 'message'])
})

it('does not resurrect rejected public output from delayed chunks or completions after settlement', () => {
	let thread = running()
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'answer',
		turnId: 'native',
		text: 'Rejected draft',
	})
	thread = update(thread, {
		kind: 'turn_ended',
		messageId: 'answer',
		turnId: 'native',
		stopReason: 'refused',
		reason: 'output_guardrail',
		result: '',
	})
	const settled = thread
	for (const value of [
		{
			kind: 'agent_message_chunk',
			messageId: 'answer',
			turnId: 'native',
			text: 'Late rejected tail',
		},
		{
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			turnId: 'native',
			stopReason: 'end_turn',
			content: 'Late rejected final',
		},
		{
			kind: 'agent_thought',
			status: 'pending',
			messageId: 'answer',
			turnId: 'native',
			blockId: 'answer:0',
		},
	] satisfies AcpSessionUpdate[]) {
		thread = update(thread, value)
		expect(thread).toBe(settled)
	}
	expect(thread.messages).toEqual([])
	expect(threadPhase(thread)).toBe('idle')
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'New request' })
	thread = update(thread, {
		kind: 'agent_message_chunk',
		messageId: 'answer',
		turnId: 'new-native',
		text: 'New answer with reused message ID',
	})
	expect(thread.messages.at(-1)?.text).toBe('New answer with reused message ID')
})
