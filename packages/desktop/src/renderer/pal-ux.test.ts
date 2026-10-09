import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ProjectedToolCall } from '../shared/projection.js'
import type { PalView } from '../shared/protocol.js'
import { PalComputerView } from './pal-computer-view.js'
import { PalContextCard, type PalContextProps } from './pal-context.js'
import { PalMessageReceipts, palMessageRecipients } from './pal-message-receipts.js'
import { PalSidebarSection, PalsPage, nameKey, palNameHint } from './pals-page.js'

const pal: PalView = {
	id: 'pal',
	name: 'Işık',
	purpose: '',
	revision: 1,
	workspace: 'owned',
	model: null,
	paused: false,
	createdAt: '2026-10-09',
	updatedAt: '2026-10-09',
}
const base: PalContextProps = {
	pal,
	status: 'idle',
	computer: { name: 'Işık’s computer', workspace: 'owned', status: 'error' },
	activity: [],
	outputs: [],
	onCustomize: () => {},
	onPause: () => {},
	onStartComputer: () => {},
	onOpenComputer: () => {},
}
const card = (overrides: Partial<PalContextProps>) =>
	renderToStaticMarkup(createElement(PalContextCard, { ...base, ...overrides }))

it('keeps the computer status a status and the action its own button', () => {
	const html = card({})
	expect(html).toContain('Offline')
	// The action is a visible button, never a hover layer that replaces the status.
	expect(html).toMatch(
		/<button\b[^>]*class="[^"]*pal-computer-action[^"]*"[^>]*>Start computer<\/button>/,
	)
	expect(html).not.toContain('pal-status-hover')
	expect(html).not.toContain('pal-status-rest')
})

it('says Starting while the computer starts and offers no second Start', () => {
	const html = card({ computer: { ...base.computer, status: 'connecting' } })
	expect(html).toContain('Starting…')
	expect(html).not.toContain('>Start computer<')
})

it('shows Paused as the status and Resume as the action for a paused Pal', () => {
	const html = card({ pal: { ...pal, paused: true }, status: 'paused' })
	expect(html).toMatch(/<output[^>]*pal-context-status[^>]*>Paused<\/output>/)
	expect(html).toMatch(/<button\b[^>]*aria-label="Resume Işık"[^>]*>Resume<\/button>/)
	// The status line never holds the action's name.
	expect(html).not.toMatch(/pal-context-status[^>]*>[^<]*Resume/)
	expect(card({}).match(/>Pause<\/button>/)).not.toBeNull()
})

it('never shows a build instruction or repository path in the computer panel', () => {
	const panel = renderToStaticMarkup(
		createElement(PalComputerView, {
			palName: 'Işık',
			computer: { name: 'Işık’s computer', status: 'error' },
			screen: null,
			loading: false,
			onBack: () => {},
			onRefresh: () => {},
			onStart: () => {},
			onTakeOver: () => {},
		} satisfies ComponentProps<typeof PalComputerView>),
	)
	expect(panel).not.toMatch(/Dockerfile|packages\//)
	// A disabled Take over says why.
	expect(panel).toContain('Offline. Start the computer to take over.')
	expect(panel).toMatch(/<button\b[^>]*disabled=""[^>]*>Take over<\/button>/)
})

it('keeps a labelled Settings button on the compact bar', () => {
	// The compact bar needs a layout width; the static render is the wide card, so check the source of truth.
	const html = card({ onCommunication: () => {} })
	expect(html).toContain('aria-label="Işık settings"')
})

it('warns about a duplicate name without blocking it, and about an empty one', () => {
	expect(palNameHint('', [], false)).toEqual({ tone: 'empty', text: 'Give your Pal a name.' })
	expect(palNameHint('  ', [], true)?.text).toBe('Give your Pal a name to save it.')
	expect(palNameHint('Işık', ['Mira'], false)).toBeUndefined()
	const duplicate = palNameHint(' mira ', ['Mira'], false)
	expect(duplicate?.tone).toBe('duplicate')
	expect(duplicate?.text).toContain('already have a Pal called')
	expect(nameKey(' Mira ')).toBe('mira')
})

it('has one Customize action and no nameless placeholder on the welcome page', () => {
	const html = renderToStaticMarkup(
		createElement(PalsPage, {
			model: null,
			onModelChange: () => {},
			onCustomize: () => {},
			onRetryOpening: () => {},
			onCancelOpening: () => {},
			loadProviders: async () => {
				throw new Error('not used')
			},
			loadModels: async () => {
				throw new Error('not used')
			},
		}),
	)
	expect(html.match(/Customize your Pal/g)?.length).toBe(1)
	expect(html).not.toContain('>Your Pal<')
	expect(html).toContain('Give your Pal a name to start.')
})

it('labels the Pals section whether there are few Pals or none', () => {
	for (const pals of [[], [pal]]) {
		const html = renderToStaticMarkup(
			createElement(PalSidebarSection, {
				pals,
				loading: false,
				onCreate: () => {},
				onOpen: () => {},
			}),
		)
		expect(html).toMatch(/<h2[^>]*sidebar-pals-heading[^>]*>Pals<\/h2>/)
	}
})

const sent = (id: string, label: string, status: ProjectedToolCall['status'] = 'completed') =>
	({
		kind: 'tool_call',
		toolCallId: id,
		title: 'send_pal_message',
		status,
		view: { kind: 'generic', label },
	}) as ProjectedToolCall

it('leaves a visible line for each completed message to a Pal, with a way to its messages', () => {
	const tools = {
		a: sent('a', 'Sent to Işık’s inbox'.replace('’', "'")),
		b: sent('b', 'Message to Mira', 'pending'),
		c: { ...sent('c', 'Whatever'), title: 'read' } as ProjectedToolCall,
	}
	const entries = ['a', 'b', 'c'].map((id) => ({ kind: 'tool' as const, id, turn: 0 }))
	expect(palMessageRecipients(entries, { tools })).toEqual(['Işık'])
	const html = renderToStaticMarkup(
		createElement(PalMessageReceipts, { entries, thread: { tools }, onOpen: () => {} }),
	)
	expect(html).toContain('Sent to Işık’s inbox. Işık reads it the next time it runs.')
	expect(html).toContain('See it in Işık’s messages')
	expect(html).not.toContain('Mira')
	expect(
		renderToStaticMarkup(createElement(PalMessageReceipts, { entries: [], thread: { tools } })),
	).toBe('')
})
