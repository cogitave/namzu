import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from './projection.js'
import type { DesktopEvent } from './protocol.js'

const event = (update: Extract<DesktopEvent, { kind: 'update' }>['update']): DesktopEvent => ({
	kind: 'update',
	projectId: 'p',
	sessionId: 's',
	update,
})

it('reconciles a settled answer with its actual streamed message identity once', () => {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Answer once' })
	thread = applyEvent(
		thread,
		event({ kind: 'agent_message_chunk', messageId: 'actual-id', text: 'One answer' }),
	)
	thread = applyEvent(
		thread,
		event({
			kind: 'agent_message',
			status: 'completed',
			messageId: 'actual-id',
			content: 'One answer',
			stopReason: 'end_turn',
		}),
	)
	thread = applyEvent(
		thread,
		event({
			kind: 'turn_ended',
			messageId: 'actual-id',
			result: 'One answer',
			stopReason: 'end_turn',
		}),
	)
	expect(thread.messages).toHaveLength(2)
	expect(thread.messages[1]).toMatchObject({
		messageId: 'actual-id',
		text: 'One answer',
		status: 'completed',
	})
	expect(thread.timeline.filter((entry) => entry.kind === 'message')).toHaveLength(2)
})

it('keeps legitimate repeated text under distinct message identities across tools and turns', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'First request',
	})
	for (const [id, stopReason] of [
		['commentary', 'tool_use'],
		['answer', 'end_turn'],
	] as const) {
		thread = applyEvent(
			thread,
			event({ kind: 'agent_message_chunk', messageId: id, text: 'Repeated text' }),
		)
		thread = applyEvent(
			thread,
			event({
				kind: 'agent_message',
				status: 'completed',
				messageId: id,
				content: 'Repeated text',
				stopReason,
			}),
		)
	}
	thread = applyEvent(
		thread,
		event({
			kind: 'turn_ended',
			messageId: 'answer',
			result: 'Repeated text',
			stopReason: 'end_turn',
		}),
	)
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Second request' })
	thread = applyEvent(
		thread,
		event({
			kind: 'agent_message',
			messageId: 'later-answer',
			content: 'Repeated text',
			status: 'completed',
			stopReason: 'end_turn',
		}),
	)
	thread = applyEvent(
		thread,
		event({
			kind: 'turn_ended',
			messageId: 'later-answer',
			result: 'Repeated text',
			stopReason: 'end_turn',
		}),
	)
	expect(
		thread.messages
			.filter((message) => message.role === 'assistant')
			.map((message) => [message.messageId, message.text]),
	).toEqual([
		['commentary', 'Repeated text'],
		['answer', 'Repeated text'],
		['later-answer', 'Repeated text'],
	])
})
