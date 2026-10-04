import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Composer } from './composer.js'

// Materialize portal content for these rendering/admission assertions. Native tests
// verify the actual Base UI popup positioning and focus behavior.
vi.mock('./ui/popover.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./ui/popover.js')>()
	return {
		...actual,
		PopoverPopup: ({ children, ...props }: ComponentProps<typeof actual.PopoverPopup>) =>
			createElement('div', { 'aria-label': props['aria-label'] }, children),
	}
})

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

it('docks the slim Pal composer with one authored textarea and preserves the standard composer', () => {
	const pal = render({ variant: 'pal', empty: true })
	expect(pal).toContain('data-composer-variant="pal"')
	expect(pal).toContain('placeholder="Send a message"')
	expect(pal).toContain('bottom-0')
	expect(pal.match(/<textarea\b/g)).toHaveLength(1)
	expect(pal).toContain('An unsent Pal request</textarea>')
	expect(pal.indexOf('aria-label="Attachments and message settings"')).toBeLessThan(
		pal.indexOf('<textarea'),
	)
	expect(pal.indexOf('<textarea')).toBeLessThan(pal.indexOf('aria-label="Send message"'))
	expect(pal).not.toContain('data-slot="composer-context-strip"')
	expect(pal).not.toContain('What would you like to work on?')
	expect(pal).not.toContain('Ideas to get started')
	const standard = render({ empty: true })
	expect(standard).toContain('data-composer-variant="default"')
	expect(standard).toContain('data-slot="composer-context-strip"')
	expect(standard).toContain('What would you like to work on?')
	expect(standard).toContain('placeholder="Ask Namzu anything"')
})

it('keeps the Pal Plus menu and actual model available while computer execution is offline', () => {
	const html = render({ variant: 'pal', modelSelectionReady: true })
	expect(button(html, 'Attachments and message settings')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Select model')).not.toMatch(/\bdisabled=/)
	expect(html.match(/aria-label="Select model"/g)).toHaveLength(1)
	expect(button(html, 'Attach files')).toMatch(/\bdisabled=/)
	expect(button(html, 'Tool permissions')).toMatch(/\bdisabled=/)
	expect(button(html, 'Plugins')).toMatch(/\bdisabled=/)
	expect(button(html, 'Send message')).toMatch(/\bdisabled=/)
	for (const work of [{ running: true }, { sending: true }])
		expect(
			button(render({ variant: 'pal', modelSelectionReady: true, ...work }), 'Select model'),
		).toMatch(/\bdisabled=/)
})

it('retains Pal attachments, queue editing and complete approval while composing the next turn', () => {
	const html = render({
		variant: 'pal',
		connected: true,
		running: true,
		attachments: [
			{ id: 'file', name: 'notes.txt', kind: 'text', size: 20, mediaType: 'text/plain' },
		],
		queued: ['Later request'],
		queuedItems: [{ id: 'queued', prompt: 'Later request' }],
		permissions: [
			{
				id: 'approval',
				projectId: 'pal-control',
				sessionId: 'owned',
				calls: [{ id: 'call', name: 'bash', input: { command: 'pwd' }, isDestructive: false }],
			},
		],
	})
	expect(html).toContain('notes.txt')
	expect(button(html, 'Remove notes.txt')).not.toMatch(/\bdisabled=/)
	expect(html).toContain('Later request')
	expect(button(html, 'Edit queued message 1')).toMatch(/\bdisabled=/)
	expect(button(html, 'Remove queued message 1')).not.toMatch(/\bdisabled=/)
	expect(html).toContain('aria-label="Tool approval"')
	expect(html).toContain('pwd')
	expect(html).toContain('Allow once')
	expect(button(html, 'Stop turn')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Queue message')).not.toMatch(/\bdisabled=/)
})
