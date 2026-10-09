import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread, restoreMessages } from '../shared/projection.js'
import type { AttachmentView, ChatMessage } from '../shared/protocol.js'
import { PalChatTranscript, palChatRows, palChatStatus } from './pal-chat-transcript.js'

const file: AttachmentView = {
	id: 'attachment',
	name: 'proof.txt',
	kind: 'text',
	size: 10,
	mediaType: 'text/plain',
}

function started(prompt = 'Hello', attachments?: AttachmentView[]): ThreadState {
	return applyEvent(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 'session', prompt, attachments }),
		{ kind: 'state', sessionId: 'session', running: true, queued: [] },
	)
}

function update(thread: ThreadState, value: AcpSessionUpdate): ThreadState {
	return applyEvent(thread, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: value,
	})
}

function render(thread: ThreadState, intro?: { id: string; text: string }): string {
	return renderToStaticMarkup(createElement(PalChatTranscript, { thread, name: 'Kiro', intro }))
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
	return value
}

describe('delivered Pal chat rows', () => {
	it('offers the message action only after the current turn settles', () => {
		const delivered = update(started(), {
			kind: 'agent_message',
			status: 'completed',
			content: 'Delivered answer',
			messageId: 'answer',
			stopReason: 'end_turn',
		})
		const action = vi.fn((_message: ChatMessage, _key: string) =>
			createElement('button', { type: 'button' }, 'Listen'),
		)
		const draw = (thread: ThreadState) =>
			renderToStaticMarkup(
				createElement(PalChatTranscript, {
					thread,
					name: 'Kiro',
					renderMessageAction: action,
				}),
			)
		expect(draw(delivered)).not.toContain('Listen')
		expect(action).not.toHaveBeenCalled()
		const settled = update(delivered, { kind: 'turn_ended', stopReason: 'end_turn' })
		expect(draw(settled)).toContain('Listen')
		expect(action).toHaveBeenCalledOnce()
		expect(action.mock.calls[0]?.[0]).toMatchObject({ role: 'assistant', text: 'Delivered answer' })
	})
	it('keeps a streamed answer private until an authoritative complete message arrives', () => {
		const streaming = update(started(), {
			kind: 'agent_message_chunk',
			text: 'Provisional answer',
			messageId: 'answer',
			phase: 'final_answer',
		})
		expect(streaming.messages.at(-1)?.text).toBe('Provisional answer')
		expect(palChatRows(streaming).map((row) => row.message.text)).toEqual(['Hello'])
		expect(render(streaming)).not.toContain('Provisional answer')
		const completed = update(streaming, {
			kind: 'agent_message',
			status: 'completed',
			content: 'Delivered answer',
			messageId: 'answer',
			stopReason: 'end_turn',
		})
		expect(palChatRows(completed).map((row) => row.message.text)).toEqual([
			'Hello',
			'Delivered answer',
		])
		expect(render(completed)).toContain('Delivered answer')
		expect(render(completed)).not.toContain('Provisional answer')
	})

	it('delivers the same streamed text when turn settlement preserves its pending row', () => {
		const streaming = update(started(), {
			kind: 'agent_message_chunk',
			text: 'Same final text',
			messageId: 'answer',
			phase: 'final_answer',
		})
		const settled = update(streaming, {
			kind: 'turn_ended',
			stopReason: 'end_turn',
			result: 'Same final text',
			messageId: 'answer',
		})
		expect(settled.messages.at(-1)?.status).toBe('pending')
		expect(palChatRows(settled).map((row) => row.message.text)).toEqual([
			'Hello',
			'Same final text',
		])
		expect(render(settled).match(/Same final text/g)).toHaveLength(1)
	})

	it('delivers only explicitly final parts from a settled mixed-part message and retains its untouched draft', () => {
		const completed = update(started(), {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			content: 'Selected final answer',
			textParts: [
				{ id: 'unphased', text: 'Earlier unphased draft' },
				{ id: 'final', text: 'Selected final answer', phase: 'final_answer' },
			],
			stopReason: 'end_turn',
		})
		const original = structuredClone(completed)
		freeze(completed)
		for (const thread of [
			completed,
			update(completed, {
				kind: 'turn_ended',
				stopReason: 'end_turn',
				result: 'Selected final answer',
				messageId: 'answer',
			}),
		]) {
			expect(palChatRows(thread).map((row) => row.message.text)).toEqual([
				'Hello',
				'Selected final answer',
			])
			expect(render(thread)).not.toContain('Earlier unphased draft')
			expect(render(thread).match(/Selected final answer/g)).toHaveLength(1)
		}
		expect(completed).toEqual(original)
		expect(completed.messages.some((message) => message.text === 'Earlier unphased draft')).toBe(
			true,
		)
	})

	it('selects all final parts for one message without withdrawing a distinct legacy reply or earlier turn', () => {
		let thread = restoreMessages(emptyThread(), [
			{ role: 'user', text: 'Previous question' },
			{ role: 'assistant', text: 'Previous unphased answer', messageId: 'answer' },
		])
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 'session', prompt: 'Next question' })
		thread = applyEvent(thread, { kind: 'state', sessionId: 'session', running: true, queued: [] })
		thread = update(thread, {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'legacy',
			content: 'Distinct unphased reply',
			stopReason: 'end_turn',
		})
		thread = update(thread, {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			textParts: [
				{ id: 'draft', text: 'Undelivered draft' },
				{ id: 'first', text: 'First final part', phase: 'final_answer' },
				{ id: 'second', text: 'Second final part', phase: 'final_answer' },
			],
			stopReason: 'end_turn',
		})
		expect(palChatRows(thread).map((row) => row.message.text)).toEqual([
			'Previous question',
			'Previous unphased answer',
			'Next question',
			'Distinct unphased reply',
			'First final part',
			'Second final part',
		])
		expect(render(thread)).not.toContain('Undelivered draft')
	})

	it('keeps commentary, thoughts and tool receipts available to the ordinary projection only', () => {
		let thread = update(started(), {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'commentary',
			textParts: [{ id: 'commentary-part', phase: 'commentary', text: 'Inspecting the workspace' }],
			stopReason: 'end_turn',
		})
		thread = update(thread, { kind: 'agent_thought_chunk', text: 'Reasoning body' })
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'tool',
			title: 'Private tool title',
			status: 'completed',
			view: { kind: 'terminal', command: 'pwd', output: 'Private tool output' },
		})
		thread = update(thread, {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			textParts: [{ id: 'final-part', phase: 'final_answer', text: 'Delivered answer' }],
			stopReason: 'end_turn',
		})
		const original = structuredClone(thread)
		freeze(thread)
		const rows = palChatRows(thread)
		expect(rows.map((row) => row.message.text)).toEqual(['Hello', 'Delivered answer'])
		expect(rows[1]?.message).toBe(thread.messages.at(-1))
		const html = render(thread)
		for (const hidden of [
			'Inspecting the workspace',
			'Reasoning body',
			'Private tool title',
			'Private tool output',
		])
			expect(html).not.toContain(hidden)
		expect(thread).toEqual(original)
		expect(thread.tools['1:tool']?.view).toEqual(original.tools['1:tool']?.view)
		expect(Object.values(thread.reasoning)[0]?.text).toBe('Reasoning body')
	})

	it('does not expose a completed tool-use assistant message as a delivered reply', () => {
		const thread = update(started(), {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'tool-answer',
			content: 'I will call a tool',
			stopReason: 'tool_use',
		})
		expect(thread.messages.at(-1)?.status).toBe('completed')
		expect(palChatRows(thread).map((row) => row.message.text)).toEqual(['Hello'])
		expect(render(thread)).not.toContain('I will call a tool')
	})

	it.each(['cancelled', 'error'] as const)(
		'keeps an interrupted partial out of delivered chat after %s settlement',
		(reason) => {
			let thread = update(started(), {
				kind: 'agent_message',
				status: 'completed',
				messageId: 'delivered',
				content: 'A real delivered reply.',
				stopReason: 'end_turn',
			})
			thread = update(thread, {
				kind: 'agent_message_chunk',
				messageId: 'partial',
				text: 'An unfinished reply',
			})
			thread = update(thread, {
				kind: 'agent_message',
				status: 'completed',
				messageId: 'partial',
				content: 'An unfinished reply',
				stopReason: 'cancelled',
			})
			thread = update(thread, { kind: 'turn_ended', stopReason: reason, reason })
			const before = structuredClone(thread)
			expect(palChatRows(thread).map(({ message }) => message.text)).toEqual([
				'Hello',
				'A real delivered reply.',
			])
			expect(render(thread)).not.toContain('An unfinished reply')
			expect(render(thread)).toContain('A real delivered reply.')
			expect(thread.messages.at(-1)?.text).toBe('An unfinished reply')
			expect(thread).toEqual(before)
		},
	)

	it('does not move an early completed answer across later work into the chat suffix', () => {
		let thread = update(started(), {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'early',
			textParts: [{ id: 'early-part', phase: 'final_answer', text: 'Early interim response' }],
			stopReason: 'end_turn',
		})
		thread = update(thread, { kind: 'agent_thought_chunk', text: 'Later work' })
		thread = update(thread, {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'final',
			textParts: [{ id: 'final-part', phase: 'final_answer', text: 'Final delivered response' }],
			stopReason: 'end_turn',
		})
		expect(palChatRows(thread).map((row) => row.message.text)).toEqual([
			'Hello',
			'Final delivered response',
		])
		expect(thread.messages.some((message) => message.text === 'Early interim response')).toBe(true)
	})

	it('withdraws a rejected streamed answer when settlement authoritatively returns empty text', () => {
		const streaming = update(started(), {
			kind: 'agent_message_chunk',
			messageId: 'answer',
			text: 'Rejected provisional answer',
		})
		const settled = update(streaming, {
			kind: 'turn_ended',
			stopReason: 'refused',
			result: '',
			messageId: 'answer',
		})
		expect(palChatRows(settled).map((row) => row.message.text)).toEqual(['Hello'])
		expect(render(settled)).not.toContain('Rejected provisional answer')
	})

	it('retains delivered legacy history while hiding an unphased current live chunk', () => {
		let thread = restoreMessages(emptyThread(), [
			{ role: 'user', text: 'Previous question' },
			{ role: 'assistant', text: 'Previous delivered answer' },
		])
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 'session', prompt: 'Next question' })
		thread = applyEvent(thread, { kind: 'state', sessionId: 'session', running: true, queued: [] })
		thread = update(thread, { kind: 'agent_message_chunk', text: 'Unphased live text' })
		expect(palChatRows(thread).map((row) => row.message.text)).toEqual([
			'Previous question',
			'Previous delivered answer',
			'Next question',
		])
		expect(render(thread)).not.toContain('Unphased live text')
	})

	it('keeps file-only user messages and does not render empty attachment arrays as zero', () => {
		const fileOnly = started('', [file])
		expect(palChatRows(fileOnly)).toHaveLength(1)
		expect(palChatRows(fileOnly)[0]?.message.attachments).toEqual([file])
		const html = render(fileOnly)
		expect(html).toContain('aria-label="Message attachments"')
		expect(html).toContain('proof.txt')
		expect(html).toContain('data-attachment-id="attachment"')
		const empty = restoreMessages(emptyThread(), [
			{ role: 'user', text: 'No files', attachments: [] },
			{ role: 'assistant', text: '', attachments: [] },
		])
		expect(palChatRows(empty)).toHaveLength(1)
		expect(render(empty)).not.toContain('>0<')
		expect(render(empty)).not.toContain('Message attachments')
	})

	it('renders user text literally and delivered assistant Markdown inside accessible chat bubbles', () => {
		const thread = update(started('**literal user text**'), {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			content: '**Delivered answer**',
			stopReason: 'end_turn',
		})
		const html = render(thread)
		expect(html).toContain('role="log"')
		expect(html).toContain('aria-label="Kiro messages"')
		expect(html).toContain('**literal user text**')
		expect(html).not.toContain('<strong>literal user text</strong>')
		expect(html).toContain('<strong>Delivered answer</strong>')
	})
})

describe('actual Pal chat activity', () => {
	it('uses the admitted reasoning and answer-stream phases for typing, without showing their body', () => {
		const thinking = update(started(), { kind: 'agent_thought_chunk', text: 'Hidden thoughts' })
		expect(palChatStatus(thinking)).toBe('Typing…')
		const responding = update(thinking, {
			kind: 'agent_message_chunk',
			messageId: 'answer',
			text: 'Pending answer',
		})
		expect(palChatStatus(responding)).toBe('Typing…')
		const html = render(responding)
		expect(html).toContain('data-pal-chat-phase="responding"')
		expect(html).toContain('aria-live="polite"')
		expect(html).toContain('pal-chat-typing')
		expect(html).not.toContain('Hidden thoughts')
		expect(html).not.toContain('Pending answer')
	})

	it('gives pending approval priority over real tool work and clears it without inventing idle activity', () => {
		let thread = started()
		expect(palChatStatus(thread)).toBe('Working…')
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'tool',
			title: 'Read file',
			status: 'pending',
			view: { kind: 'terminal', command: 'read', output: '' },
		})
		expect(palChatStatus(thread)).toBe('Working…')
		thread = applyEvent(thread, {
			kind: 'permission',
			request: {
				id: 'approval',
				sessionId: 'session',
				projectId: 'project',
				calls: [],
			},
		})
		expect(palChatStatus(thread)).toBe('Waiting for your decision')
		expect(render(thread)).toContain('data-pal-chat-phase="waiting"')
		thread = applyEvent(thread, {
			kind: 'permission-cleared',
			sessionId: 'session',
			requestId: 'approval',
		})
		expect(palChatStatus(thread)).toBe('Working…')
		thread = applyEvent(thread, { kind: 'state', sessionId: 'session', running: false, queued: [] })
		expect(palChatStatus(thread)).toBeUndefined()
		expect(render(thread)).not.toContain('pal-chat-status')
	})

	it('does not label queued messages as active typing or tool work', () => {
		const queued = applyEvent(emptyThread(), {
			kind: 'state',
			sessionId: 'session',
			running: false,
			queued: ['Unstarted queued prompt'],
		})
		expect(palChatStatus(queued)).toBeUndefined()
		expect(render(queued)).not.toContain('Typing')
		expect(render(queued)).not.toContain('Working')
		expect(render(queued)).not.toContain('Unstarted queued prompt')
	})

	it.each([
		['cancelled', 'Stopped.'],
		['refused', 'The action was declined.'],
		['output_guardrail', 'This reply was blocked by a safety rule that was set up.'],
	])(
		'shows the actual %s settlement notice without delivering provisional output',
		(reason, notice) => {
			let thread = update(started(), {
				kind: 'agent_message_chunk',
				messageId: 'answer',
				text: 'Undelivered partial text',
			})
			thread = update(thread, { kind: 'turn_ended', stopReason: 'cancelled', reason })
			thread = applyEvent(thread, {
				kind: 'state',
				sessionId: 'session',
				running: false,
				queued: [],
			})
			const html = render(thread)
			expect(html).toContain(notice)
			expect(html).not.toContain('Undelivered partial text')
			expect(html).not.toContain('pal-chat-status')
		},
	)
})

describe('host-authored Pal introduction', () => {
	it('preserves literal special characters in the Pal name without treating them as Markdown', () => {
		const intro = { id: 'literal-intro', text: 'Hi, I am **Kiro**_the_Pal.' }
		const html = render(emptyThread(), intro)
		expect(html).toContain('Hi, I am **Kiro**_the_Pal.')
		expect(html.match(/data-pal-chat-intro="literal-intro"/g)).toHaveLength(1)
		expect(html).not.toContain('<strong>')
		expect(html).not.toContain('<em>')
		expect(palChatRows(emptyThread())).toEqual([])
	})

	it('keeps one stable introduction before real messages without modifying the projection', () => {
		const intro = { id: 'intro', text: 'Hi, I am Kiro.' }
		let thread = update(started('First real prompt'), {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			content: 'Actual delivered reply',
			stopReason: 'end_turn',
		})
		const original = structuredClone(thread)
		freeze(thread)
		const html = render(thread, intro)
		expect(html.match(/data-pal-chat-intro="intro"/g)).toHaveLength(1)
		expect(html.match(/Hi, I am Kiro\./g)).toHaveLength(1)
		expect(html.indexOf('Hi, I am Kiro.')).toBeLessThan(html.indexOf('First real prompt'))
		expect(html.indexOf('First real prompt')).toBeLessThan(html.indexOf('Actual delivered reply'))
		expect(thread).toEqual(original)
		expect(palChatRows(thread).map((row) => row.message.text)).not.toContain(intro.text)
		thread = applyEvent(thread, {
			kind: 'prompt',
			sessionId: 'session',
			prompt: 'Second real prompt',
		})
		expect(render(thread, intro).match(/Hi, I am Kiro\./g)).toHaveLength(1)
	})

	it('does not invent an introduction when the owning host did not supply one', () => {
		const html = render(emptyThread())
		expect(html).not.toContain('data-pal-chat-intro')
		expect(html).not.toContain('Hi, I am')
		expect(palChatRows(emptyThread())).toEqual([])
	})
})
