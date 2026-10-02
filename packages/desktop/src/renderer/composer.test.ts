import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Composer } from './composer.js'

function render(overrides: Partial<ComponentProps<typeof Composer>> = {}): string {
	return renderToStaticMarkup(
		createElement(Composer, {
			inputRef: { current: null },
			draft: 'An unsent Pal request',
			onDraftChange: () => {},
			providers: {
				available: [{ id: 'zen', label: 'Zen', defaultModel: 'space-bunny-free' }],
				selected: { id: 'zen', model: 'space-bunny-free' },
			},
			connected: false,
			choice: { provider: 'zen', model: 'space-bunny-free' },
			onChoiceChange: () => {},
			running: false,
			sending: false,
			queued: [],
			queuedItems: [],
			editingQueued: false,
			onSend: () => {},
			onStop: () => {},
			onEditQueued: () => {},
			onRemoveQueued: () => {},
			projectName: 'An owned Pal',
			projectId: 'pal-control',
			projectPath: '/owned/pal-control',
			onOpenProject: () => {},
			empty: false,
			permissions: [],
			onApproval: () => {},
			attachments: [],
			attachmentsBusy: false,
			onAttach: () => {},
			onAddFiles: () => {},
			onRemoveAttachment: () => {},
			settings: { permissionMode: 'prompt' },
			capabilities: null,
			onSettingsChange: () => {},
			pluginsLoading: false,
			onOpenPlugins: () => {},
			onSetPluginEnabled: async () => {},
			...overrides,
		}),
	)
}

function button(html: string, label: string): string {
	const tag = html.match(new RegExp(`<button\\b[^>]*aria-label="${label}"[^>]*>`))?.[0]
	if (!tag) throw new Error(`Missing ${label} button`)
	return tag
}

it('allows Pal model browsing before computer admission while Send remains disabled', () => {
	const html = render({ modelSelectionReady: true })
	expect(button(html, 'Select model')).not.toMatch(/\bdisabled(?:=|\s|>)/)
	expect(button(html, 'Send message')).toMatch(/\bdisabled=/)
})

it('blocks model selection before its own catalogue context is ready', () => {
	expect(button(render({ connected: true, modelSelectionReady: false }), 'Select model')).toMatch(
		/\bdisabled=/,
	)
})

it('keeps model selection blocked during active work and sending', () => {
	for (const work of [{ running: true }, { sending: true }]) {
		expect(button(render({ modelSelectionReady: true, ...work }), 'Select model')).toMatch(
			/\bdisabled=/,
		)
	}
})

it('keeps an empty provider collection disabled even with catalogue readiness', () => {
	const html = render({
		modelSelectionReady: true,
		providers: { available: [], selected: null },
	})
	expect(button(html, 'Select model')).toMatch(/\bdisabled=/)
})

it('preserves ordinary composer readiness when no separate catalogue guard is supplied', () => {
	expect(button(render(), 'Select model')).toMatch(/\bdisabled=/)
	expect(button(render({ connected: true }), 'Select model')).not.toMatch(/\bdisabled(?:=|\s|>)/)
})
