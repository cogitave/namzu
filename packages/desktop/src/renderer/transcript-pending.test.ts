import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { PalChatTranscript } from './pal-chat-transcript.js'
import { pendingMessages } from './pending-messages.js'
import type { PendingActions } from './pending-tail.js'
import { Transcript } from './transcript.js'

beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(100000)
})
afterEach(() => {
	vi.restoreAllMocks()
})

const actions: PendingActions = {
	onSendNow: vi.fn(),
	onSave: vi.fn(async () => {}),
	onRemove: vi.fn(),
	canSendNow: true,
}

/** A first message is being answered: the reply has begun and nothing else has been said. */
function working(): ThreadState {
	return applyEvent(
		applyEvent(emptyThread(), {
			kind: 'prompt',
			sessionId: 's',
			prompt: 'First message',
			at: 53000,
		}),
		{ kind: 'state', sessionId: 's', running: true, queued: [], liveInputSupported: true },
	)
}

const steer = (
	thread: ThreadState,
	id: string,
	prompt: string,
	status: 'pending' | 'delivered' = 'pending',
) => applyEvent(thread, { kind: 'live-input', sessionId: 's', inputId: id, prompt, status })

const queue = (thread: ThreadState, items: { id: string; prompt: string }[]) =>
	applyEvent(thread, {
		kind: 'state',
		sessionId: 's',
		running: thread.running,
		liveInputSupported: true,
		queued: items.map((item) => item.prompt),
		queuedItems: items,
	})

function render(thread: ThreadState, over: { editing?: string | null } = {}): string {
	return renderToStaticMarkup(
		createElement(Transcript, {
			thread,
			pending: pendingMessages(thread),
			pendingActions: actions,
			pendingEditing: over.editing ?? null,
			onPendingEditingChange: () => {},
		}),
	)
}

const at = (html: string, needle: string) => html.indexOf(needle)

describe('waiting messages in the conversation', () => {
	it('draws one waiting message as a bubble after the last message and above the working row, with Send now', () => {
		const html = render(steer(working(), 'a', 'Selam'))
		expect(html).toContain('data-pending-tail')
		expect(html).toContain('Selam')
		expect(html).toContain('Send now')
		expect(at(html, 'First message')).toBeLessThan(at(html, 'Selam'))
		// The working row stays below the waiting bubble.
		const status = at(html, 'data-transcript-phase=')
		expect(status).toBeGreaterThan(0)
		expect(at(html, 'Selam')).toBeLessThan(status)
	})

	it('keeps a waiting message out of the history until the model takes it in', () => {
		const thread = steer(working(), 'a', 'Selam')
		expect(thread.messages.map((message) => message.text)).toEqual(['First message'])
		expect(thread.timeline.filter((entry) => entry.kind === 'message')).toHaveLength(1)
	})

	it('stacks several waiting messages in the order they will be used: into the reply first, then after it', () => {
		let thread = steer(working(), 'a', 'ONE-into')
		thread = steer(thread, 'b', 'TWO-into')
		thread = queue(thread, [
			{ id: 'q1', prompt: 'THREE-after' },
			{ id: 'q2', prompt: 'FOUR-after' },
		])
		const html = render(thread)
		const order = ['ONE-into', 'TWO-into', 'THREE-after', 'FOUR-after'].map((text) =>
			at(html, text),
		)
		expect(order.every((index) => index > 0)).toBe(true)
		expect([...order].sort((x, y) => x - y)).toEqual(order)
		expect(html.match(/data-pending-message-id=/g)).toHaveLength(4)
		// Send now on every one, Edit and Remove only where the message can still be taken back.
		expect(html.match(/aria-label="Send now: /g)).toHaveLength(4)
		expect(html.match(/aria-label="Edit: /g)).toHaveLength(2)
		expect(html.match(/aria-label="Remove: /g)).toHaveLength(2)
	})

	it('turns a message into an ordinary bubble in place once the model has it, and the tail empties', () => {
		let thread = steer(working(), 'a', 'Selam')
		thread = steer(thread, 'a', 'Selam', 'delivered')
		const html = render(thread)
		expect(html).not.toContain('data-pending-tail')
		expect(html).not.toContain('Send now')
		expect(html).toContain('Selam')
		expect(thread.messages.map((message) => message.text)).toEqual(['First message', 'Selam'])
	})

	it('removes a queued message from the tail when it leaves the queue', () => {
		let thread = queue(working(), [{ id: 'q', prompt: 'Later one' }])
		expect(render(thread)).toContain('Later one')
		thread = queue(thread, [])
		expect(render(thread)).not.toContain('Later one')
	})

	it('draws a queued message that the turn ending starts as a normal bubble with its reply after it', () => {
		let thread = queue(working(), [{ id: 'q', prompt: 'Next up' }])
		thread = applyEvent(thread, {
			kind: 'state',
			sessionId: 's',
			running: false,
			queued: ['Next up'],
			queuedItems: [{ id: 'q', prompt: 'Next up' }],
		})
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Next up', at: 60000 })
		thread = queue(
			applyEvent(thread, { kind: 'state', sessionId: 's', running: true, queued: [] }),
			[],
		)
		const html = render(thread)
		expect(html).not.toContain('data-pending-tail')
		expect(thread.messages.map((message) => message.text)).toEqual(['First message', 'Next up'])
		expect(html.match(/Next up/g)).toHaveLength(1)
	})

	it('shows the waiting message again after a restart that left it in the queue, with the hold line', () => {
		// The window restarted: the engine's queue is replayed into a settled conversation.
		const restored = applyEvent(
			applyEvent(emptyThread(), {
				kind: 'prompt',
				sessionId: 's',
				prompt: 'First message',
				at: 53000,
			}),
			{
				kind: 'state',
				sessionId: 's',
				running: false,
				queued: ['Kept'],
				queuedItems: [{ id: 'q', prompt: 'Kept' }],
			},
		)
		const html = render({ ...restored, stopReason: 'cancelled' })
		expect(html).toContain('Kept')
		expect(html).toMatch(/class="pending-note">Waiting</)
		expect(html).toContain('Paused after the stopped reply')
	})

	it('opens the editor for the message being edited, in place', () => {
		const thread = queue(working(), [{ id: 'q', prompt: 'Change me' }])
		const html = render(thread, { editing: 'q' })
		expect(html).toContain('aria-label="Edit waiting message"')
		expect(html).toContain('Change me')
		expect(html).not.toContain('aria-label="Remove: ')
	})

	it('draws nothing extra when nothing waits, and without the tail props', () => {
		expect(render(working())).not.toContain('data-pending-tail')
		const plain = renderToStaticMarkup(
			createElement(Transcript, { thread: queue(working(), [{ id: 'q', prompt: 'X-hidden' }]) }),
		)
		expect(plain).not.toContain('X-hidden')
	})
})

describe('waiting messages in a Pal conversation', () => {
	it('draws them after the last message with Send now, like any conversation', () => {
		let thread = steer(working(), 'a', 'Selam')
		thread = queue(thread, [{ id: 'q', prompt: 'Later one' }])
		const html = renderToStaticMarkup(
			createElement(PalChatTranscript, {
				thread,
				name: 'Pal',
				pending: pendingMessages(thread),
				pendingActions: actions,
				pendingEditing: null,
				onPendingEditingChange: () => {},
			}),
		)
		expect(html).toContain('data-pending-tail')
		expect(html.match(/data-pending-message-id=/g)).toHaveLength(2)
		expect(html.match(/aria-label="Send now: /g)).toHaveLength(2)
		expect(at(html, 'First message')).toBeLessThan(at(html, 'Selam'))
		expect(at(html, 'Selam')).toBeLessThan(at(html, 'Later one'))
	})

	it('draws an editor for the waiting message being edited', () => {
		const thread = queue(working(), [{ id: 'q', prompt: 'Later one' }])
		const html = renderToStaticMarkup(
			createElement(PalChatTranscript, {
				thread,
				name: 'Pal',
				pending: pendingMessages(thread),
				pendingActions: actions,
				pendingEditing: 'q',
				onPendingEditingChange: () => {},
			}),
		)
		expect(html).toContain('data-editing')
	})
})
