import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { QueuedMessageView } from '../shared/protocol.js'
import { ComposerTray } from './composer-tray.js'
import { pendingMessages } from './pending-messages.js'

const item = (id: string, prompt = id): QueuedMessageView => ({ id, prompt })
const thread = (over: Partial<Parameters<typeof pendingMessages>[0]> = {}) => ({
	running: true,
	stopReason: undefined,
	liveInputs: [],
	queuedItems: [],
	...over,
})
const live = (id: string, status: 'pending' | 'delivered' | 'unknown' = 'pending') => ({
	id,
	prompt: id,
	status,
	timelineIndex: 0,
})

it('lists what was sent into the reply first, then what waits for it, in order', () => {
	const result = pendingMessages(
		thread({ liveInputs: [live('s1'), live('s2')], queuedItems: [item('q1'), item('q2')] }),
	)
	expect(result.rows.map((row) => [row.id, row.kind, row.note, row.editable])).toEqual([
		['s1', 'steer', 'Sending to this reply', false],
		['s2', 'steer', 'Sending to this reply', false],
		['q1', 'queued', 'After this reply', true],
		['q2', 'queued', 'After this reply', true],
	])
	expect(result.hold).toBeUndefined()
})

it('drops a delivered message, says an unconfirmed one is unconfirmed, and shows no steer once settled', () => {
	expect(
		pendingMessages(thread({ liveInputs: [live('a', 'delivered'), live('b', 'unknown')] })).rows,
	).toMatchObject([{ id: 'b', note: 'Delivery not confirmed' }])
	expect(pendingMessages(thread({ running: false, liveInputs: [live('a')] })).rows).toEqual([])
})

it('says why waiting messages are held after a stopped or failed reply, and not after a finished one', () => {
	const queuedItems = [item('q')]
	expect(
		pendingMessages(thread({ running: false, stopReason: 'cancelled', queuedItems })),
	).toMatchObject({
		hold: 'Paused after the stopped reply · send a message to run them',
		rows: [{ note: 'Waiting' }],
	})
	expect(pendingMessages(thread({ running: false, stopReason: 'error', queuedItems })).hold).toBe(
		'Paused after the failed reply · send a message to run them',
	)
	expect(
		pendingMessages(thread({ running: false, stopReason: 'end_turn', queuedItems })).hold,
	).toBeUndefined()
})

function render(
	actions: Partial<Parameters<typeof ComposerTray>[0]['actions']> = {},
	editing: string | null = null,
) {
	return renderToStaticMarkup(
		createElement(ComposerTray, {
			pending: pendingMessages(thread({ liveInputs: [live('s')], queuedItems: [item('q')] })),
			actions: {
				onSendNow: vi.fn(),
				onSave: vi.fn(async () => {}),
				onRemove: vi.fn(),
				canSendNow: true,
				...actions,
			},
			editing,
			onEditingChange: vi.fn(),
		}),
	)
}

it('counts what waits and numbers each row in the order it will be used', () => {
	const html = render()
	expect(html).toContain('2 waiting')
	expect(html.match(/composer-tray-order[^>]*>(\d)/g)).toHaveLength(2)
})

it('offers Send now on every row, but Edit and Remove only where the message can still be taken back', () => {
	const rows = render().split('data-pending-message-id=').slice(1)
	expect(rows).toHaveLength(2)
	expect(rows[0]).toContain('Send now')
	expect(rows[0]).not.toContain('Edit')
	expect(rows[0]).not.toContain('Remove')
	expect(rows[1]).toContain('Send now')
	expect(rows[1]).toContain('Edit')
	expect(rows[1]).toContain('Remove')
})

it('turns the row being edited into an editor and says its keys', () => {
	const html = render({}, 'q')
	expect(html).toContain('aria-label="Edit waiting message"')
	expect(html).toContain('Enter saves · Shift+Enter adds a line · Esc cancels')
	// A message already sent into the reply never opens an editor.
	expect(render({}, 's')).not.toContain('Edit waiting message')
})

it('disables every action while the conversation is not ready, and hides Send now where it cannot work', () => {
	const off = render({ disabled: true })
	for (const label of ['Send now: q', 'Edit: q', 'Remove: q'])
		expect(off.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0]).toMatch(
			/\bdisabled=/,
		)
	expect(render({ canSendNow: false })).not.toContain('Send now')
})
