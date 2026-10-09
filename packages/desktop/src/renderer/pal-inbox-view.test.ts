import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { PalInboxView } from '../shared/pal-communication-protocol.js'
import type { ProjectedToolCall } from '../shared/projection.js'
import { emptyThread } from '../shared/projection.js'
import type { PalView } from '../shared/protocol.js'
import { PalChatTranscript } from './pal-chat-transcript.js'
import { interleavePalChat, operatorMessages } from './pal-operator-messages.js'
import { unreadAfterOpen, unreadAfterSends } from './pal-unread.js'
import { PalSidebarSection } from './pals-page.js'

const inbox = (over: Partial<PalInboxView>): PalInboxView => ({
	id: 'm1',
	status: 'pending',
	sourceKind: 'operator-conversation',
	text: 'Please look at the report',
	receivedAt: 1_700_000_000_000,
	...over,
})

it('keeps only the person’s own messages, oldest first', () => {
	const found = operatorMessages([
		inbox({ id: 'late', receivedAt: 2_000 }),
		inbox({ id: 'pal', sourceKind: 'pal', text: undefined }),
		inbox({ id: 'early', receivedAt: 1_000 }),
		inbox({ id: 'untimed', receivedAt: undefined }),
	])
	expect(found.map((item) => item.id)).toEqual(['early', 'late', 'untimed'])
})

it('places a quoted message by time and puts an untimed one last', () => {
	const row = (at: number | undefined, label: string) => ({
		label,
		message: { time: at === undefined ? undefined : { at, source: 'host' as const } },
	})
	const items = interleavePalChat(
		[row(1_000, 'a'), row(3_000, 'b'), row(undefined, 'c')],
		[
			{ id: 'x', text: 'x', status: 'pending', at: 2_000 },
			{ id: 'y', text: 'y', status: 'recorded' },
		],
	)
	expect(items.map((item) => (item.kind === 'row' ? item.row.label : item.message.id))).toEqual([
		'a',
		'x',
		'b',
		'c',
		'y',
	])
})

it('shows the person’s message quoted in the Pal’s conversation with its delivery status', () => {
	const html = renderToStaticMarkup(
		createElement(PalChatTranscript, {
			thread: emptyThread(),
			name: 'Işık',
			received: [
				{ id: 'm1', text: 'Please look at the report', status: 'pending', at: 1_700_000_000_000 },
				{ id: 'm2', text: 'And the notes', status: 'recorded', at: 1_700_000_100_000 },
			],
		}),
	)
	expect(html).toContain('<blockquote')
	expect(html).toContain('Please look at the report')
	expect(html).toContain('Waiting for Işık to read it')
	expect(html).toContain('Delivered to Işık’s conversation')
	expect(html).toContain('Sent at ')
	expect(html).not.toMatch(/Seen by Namzu|Saved in/)
})

const pals = [
	{ id: 'p1', name: 'Işık' },
	{ id: 'p2', name: 'Mira' },
	{ id: 'p3', name: 'Mira' },
]
const sendThread = () => {
	const thread = emptyThread()
	thread.timeline = [
		{ kind: 'tool', id: 'a', turn: 0 },
		{ kind: 'tool', id: 'b', turn: 0 },
	]
	thread.tools = {
		a: {
			kind: 'tool_call',
			toolCallId: 'a',
			title: 'send_pal_message',
			status: 'completed',
			view: { kind: 'generic', label: "Sent to Işık's inbox" },
		} as unknown as ProjectedToolCall,
		b: {
			kind: 'tool_call',
			toolCallId: 'b',
			title: 'send_pal_message',
			status: 'completed',
			view: { kind: 'generic', label: "Sent to Mira's inbox" },
		} as unknown as ProjectedToolCall,
	} as never
	return thread
}

it('marks a Pal unread once per send, skips an ambiguous name, and clears it on open', () => {
	const counted = new Set<string>()
	const first = unreadAfterSends(new Set(), counted, { s1: sendThread() }, pals, undefined)
	expect([...first]).toEqual(['p1'])
	// The same send is never counted twice, so opening and re-rendering does not light it again.
	const opened = unreadAfterOpen(first, 'p1')
	expect(opened.has('p1')).toBe(false)
	expect(unreadAfterSends(opened, counted, { s1: sendThread() }, pals, undefined).has('p1')).toBe(
		false,
	)
	// A Pal that is open right now is never marked.
	expect(unreadAfterSends(new Set(), new Set(), { s1: sendThread() }, pals, 'p1').has('p1')).toBe(
		false,
	)
})

it('draws the marker on a Pal row until it is opened', () => {
	const pal = (id: string, name: string): PalView => ({
		id,
		name,
		purpose: '',
		revision: 1,
		workspace: 'owned',
		model: null,
		paused: false,
		createdAt: '2026-10-09',
		updatedAt: '2026-10-09',
	})
	const render = (unreadIds: ReadonlySet<string>) =>
		renderToStaticMarkup(
			createElement(PalSidebarSection, {
				pals: [pal('p1', 'Işık'), pal('p2', 'Mira')],
				unreadIds,
				loading: false,
				onCreate: () => {},
				onOpen: () => {},
			}),
		)
	expect(render(new Set(['p1'])).match(/class="sr-only">New message</g)).toHaveLength(1)
	expect(render(new Set())).not.toContain('New message')
})
