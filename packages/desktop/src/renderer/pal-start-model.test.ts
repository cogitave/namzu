import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ProjectedToolCall } from '../shared/projection.js'
import type { PalInboxStartView } from '../shared/protocol.js'
import { PalMessageReceipts, PalStartContext } from './pal-message-receipts.js'
import {
	type PalStartEntry,
	afterRead,
	emptyPalStart,
	palStartCard,
	palWaitingLine,
} from './pal-start-model.js'
import { newPalSendTargets } from './pal-unread.js'

const view = (
	state: PalInboxStartView['state'],
	waiting = 1,
	message?: string,
): PalInboxStartView => ({
	v: 1,
	palId: 'kiro',
	waiting,
	state,
	...(message ? { message } : {}),
})
const entry = (change: Partial<PalStartEntry>): PalStartEntry => ({ ...emptyPalStart, ...change })

it('asks once, in plain words, only while the Pal is idle with a waiting message', () => {
	expect(palStartCard('Kiro', false, undefined)).toEqual({ kind: 'none' })
	expect(palStartCard('Kiro', false, entry({ view: view('waiting') }))).toEqual({
		kind: 'ask',
		text: 'Kiro is not running. Start Kiro now? It will read your message on its own computer.',
	})
	// "Not now" hides the question here; the Pal's page still offers Start.
	const dismissed = entry({ view: view('waiting'), dismissed: true })
	expect(palStartCard('Kiro', false, dismissed)).toEqual({ kind: 'none' })
	expect(palWaitingLine('Kiro', false, dismissed)).toEqual({
		text: '1 unread message',
		action: 'start',
	})
	// A running Pal gets no question.
	expect(palStartCard('Kiro', false, entry({ view: view('reading') }))).toEqual({
		kind: 'reading',
		text: 'Kiro will read it at its next step.',
		openable: false,
	})
	expect(palStartCard('Kiro', false, entry({ view: view('empty', 0) }))).toEqual({ kind: 'none' })
})

it('offers Resume for a paused Pal and never a Start', () => {
	const card = palStartCard('Kiro', true, entry({ view: view('waiting') }))
	expect(card.kind).toBe('resume')
	expect(palWaitingLine('Kiro', true, entry({ view: view('waiting', 2) }))).toEqual({
		text: '2 unread messages · Kiro is paused',
		action: 'resume',
	})
})

it('walks from the click to reading to done, and says plainly when a start failed', () => {
	let state = afterRead(undefined, view('waiting'))
	state = { ...state, clicked: true, pending: true }
	expect(palStartCard('Kiro', false, state)).toEqual({ kind: 'starting', text: 'Starting Kiro…' })
	state = afterRead({ ...state, pending: false }, view('reading'))
	expect(palStartCard('Kiro', false, state)).toMatchObject({
		kind: 'reading',
		text: 'Kiro is reading your message.',
		openable: true,
	})
	state = afterRead(state, view('empty', 0))
	expect(palStartCard('Kiro', false, state)).toEqual({
		kind: 'done',
		text: 'Kiro read your message.',
	})
	// New messages after everything was read are a new question.
	state = afterRead(state, view('waiting'))
	expect(palStartCard('Kiro', false, state).kind).toBe('ask')

	const missing =
		'Kiro’s computer is not available on this machine yet. Install and start Docker or Podman, then start Kiro again.'
	const failed = entry({ view: view('failed', 1, missing) })
	expect(palStartCard('Kiro', false, failed)).toEqual({ kind: 'failed', text: missing })
	expect(palWaitingLine('Kiro', false, failed)?.action).toBe('retry')
	expect(
		palStartCard('Kiro', false, entry({ view: view('waiting'), error: 'start-failed' })),
	).toEqual({
		kind: 'failed',
		text: 'Kiro could not be started. Try again in a moment.',
	})
})

const sent = (id: string): ProjectedToolCall =>
	({
		kind: 'tool_call',
		toolCallId: id,
		title: 'send_pal_message',
		status: 'completed',
		view: { kind: 'generic', label: "Sent to Kiro's inbox" },
	}) as ProjectedToolCall

it('draws the question under the send row with Start and Not now, and a quiet line without it', () => {
	const tools = { a: sent('a') }
	const entries = [{ kind: 'tool' as const, id: 'a', turn: 0 }]
	const html = (card: ReturnType<typeof palStartCard>) =>
		renderToStaticMarkup(
			createElement(
				PalStartContext.Provider,
				{
					value: {
						card: () => card,
						onStart: () => {},
						onNotNow: () => {},
						onResume: () => {},
						onOpenPal: () => {},
					},
				},
				createElement(PalMessageReceipts, { entries, thread: { tools }, onOpen: () => {} }),
			),
		)
	const ask = html(palStartCard('Kiro', false, entry({ view: view('waiting') })))
	expect(ask).toContain('Start Kiro now?')
	expect(ask).toContain('>Start Kiro<')
	expect(ask).toContain('>Not now<')
	expect(ask).not.toContain('reads it the next time it runs')
	const reading = html(palStartCard('Kiro', false, entry({ view: view('reading'), clicked: true })))
	expect(reading).toContain('Kiro is reading your message.')
	expect(reading).toContain('Open Kiro')
	expect(reading).not.toContain('Not now')
	const failed = html({ kind: 'failed', text: 'Kiro could not be started. Try again in a moment.' })
	expect(failed).toContain('Retry')
	// Without the question the original line stays.
	expect(html({ kind: 'none' })).toContain(
		'Sent to Kiro’s inbox. Kiro reads it the next time it runs.',
	)
})

it('names each Pal a message went to once, and only when exactly one Pal has that name', () => {
	const tools = { a: sent('a') }
	const thread = {
		tools,
		timeline: [{ kind: 'tool' as const, id: 'a', turn: 0 }],
	} as never
	const seen = new Set<string>()
	const pals = [{ id: 'kiro', name: 'Kiro' }]
	expect(newPalSendTargets(seen, { s: thread }, pals)).toEqual(['kiro'])
	expect(newPalSendTargets(seen, { s: thread }, pals)).toEqual([])
	expect(
		newPalSendTargets(new Set(), { s: thread }, [...pals, { id: 'other', name: 'Kiro' }]),
	).toEqual([])
})
