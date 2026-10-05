import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PalComputerView } from './pal-computer-view.js'
import { PalContextCard } from './pal-context.js'

const screen = {
	source: 'data:image/png;base64,actual-capture',
	width: 1280,
	height: 800,
}
function render(overrides: Partial<ComponentProps<typeof PalComputerView>> = {}) {
	return renderToStaticMarkup(
		createElement(PalComputerView, {
			palName: 'Palu',
			computer: { name: 'Palu’s computer', status: 'ready' },
			screen,
			loading: false,
			control: { supported: true, mode: 'pal' },
			onBack: () => {},
			onRefresh: () => {},
			onTakeOver: () => {},
			onRelease: () => {},
			...overrides,
		}),
	)
}
function takeOver(html: string) {
	const tag = html.match(/<button\b[^>]*>Take over<\/button>/)?.[0]
	if (!tag) throw new Error('No Take over button')
	return tag
}
function returnControl(html: string) {
	const tag = html.match(/<button\b[^>]*>Return control<\/button>/)?.[0]
	if (!tag) throw new Error('No Return control button')
	return tag
}

it('reports only actual control support and never enables takeover while offline or transitioning', () => {
	expect(takeOver(render())).not.toContain('disabled=')
	for (const state of [
		{ control: undefined },
		{ control: { supported: false, mode: 'unavailable' as const } },
		{ control: { supported: true, mode: 'transitioning' as const } },
		{ computer: { name: 'Palu’s computer', status: 'error' as const } },
		{ screen: null },
		{ loading: true },
	])
		expect(takeOver(render(state))).toContain('disabled=')
	expect(render({ control: undefined })).toContain('Viewing only')
	expect(render({ control: { supported: true, mode: 'operator' } })).toContain('You have control')
})

it('shows only captured guest pixels, and treats an offline frame as unavailable', () => {
	const html = render()
	expect(html).toContain('data:image/png;base64,actual-capture')
	expect(html).toContain('actual computer screen')
	expect(html).not.toContain('role="dialog"')
	const offline = render({
		computer: { name: 'Palu’s computer', status: 'error', notice: '<unsafe>' },
	})
	expect(offline).toContain('Computer is offline')
	expect(offline).toContain('&lt;unsafe&gt;')
	expect(offline).not.toContain('<img')
	const missingFrame = render({ screen: null })
	expect(missingFrame).toContain('Screen unavailable')
	expect(missingFrame).not.toContain('Computer is offline')
})

it('keeps Return control available across ordinary guest input while retaining offline and transfer fences', () => {
	const operator = { supported: true, mode: 'operator' as const }
	const idle = returnControl(render({ control: operator, inputBusy: false }))
	const sending = returnControl(render({ control: operator, inputBusy: true }))
	expect(idle).not.toContain('disabled=')
	expect(sending).toBe(idle)
	for (const state of [
		{ controlBusy: true },
		{ computer: { name: 'Palu’s computer', status: 'connecting' as const } },
		{ computer: { name: 'Palu’s computer', status: 'error' as const } },
	])
		expect(returnControl(render({ control: operator, inputBusy: true, ...state }))).toContain(
			'disabled=',
		)
	const changing = render({
		control: { supported: true, mode: 'transitioning' },
	})
	expect(changing).not.toContain('Return control')
	expect(takeOver(changing)).toContain('disabled=')
	expect(render({ control: operator, inputBusy: true })).toContain('data-interactive="false"')
})

it('shows the host row only for actual supplied metadata, and puts the real capture in the thumbnail', () => {
	const props: ComponentProps<typeof PalContextCard> = {
		pal: {
			id: 'pal',
			name: 'Palu',
			purpose: '',
			revision: 1,
			workspace: 'owned',
			model: null,
			paused: false,
			createdAt: '2026-10-04',
			updatedAt: '2026-10-04',
		},
		status: 'idle',
		computer: {
			name: 'Palu’s computer',
			workspace: 'owned',
			status: 'ready',
			screen,
		},
		activity: [],
		outputs: [],
		onCustomize: () => {},
		onOpenComputer: () => {},
	}
	const withoutHost = renderToStaticMarkup(createElement(PalContextCard, props))
	expect(withoutHost).not.toContain('Your computer')
	expect(withoutHost).toContain('pal-computer-thumbnail')
	expect(withoutHost).toContain(screen.source)
	expect(withoutHost).toContain('Open Palu’s computer')
	const withHost = renderToStaticMarkup(
		createElement(PalContextCard, {
			...props,
			hostComputer: { name: 'ACTUAL-HOST' },
		}),
	)
	expect(withHost).toContain('ACTUAL-HOST')
	expect(withHost).toContain('Your computer')
})
