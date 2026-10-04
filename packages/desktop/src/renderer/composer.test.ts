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
			{
				id: 'file',
				name: 'notes.txt',
				kind: 'text',
				size: 20,
				mediaType: 'text/plain',
			},
		],
		queued: ['Later request'],
		queuedItems: [{ id: 'queued', prompt: 'Later request' }],
		permissions: [
			{
				id: 'approval',
				projectId: 'pal-control',
				sessionId: 'owned',
				calls: [
					{
						id: 'call',
						name: 'bash',
						input: { command: 'pwd' },
						isDestructive: false,
					},
				],
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

it('keeps real context above the normal editor and permissions beside Plus below it', () => {
	const html = render({
		connected: true,
		projectName: 'namzu',
		computerLabel: 'This computer',
		choice: {
			provider: 'zen',
			model: 'claude-sonnet-4-5',
			label: 'Claude Sonnet 4.5',
		},
	})
	const context = html.indexOf('data-slot="composer-context-strip"')
	const editor = html.indexOf('<textarea')
	const footer = html.indexOf('data-chat-composer-footer')
	const plus = html.indexOf('aria-label="Attachments and message settings"', footer)
	const permission = html.indexOf('aria-label="Tool permissions"', footer)
	const model = html.indexOf('aria-label="Select model"', footer)
	const submit = html.indexOf('aria-label="Send message"', footer)
	expect(context).toBeGreaterThan(0)
	expect(context).toBeLessThan(editor)
	expect(html.slice(context, editor)).toContain('This computer')
	expect(html.slice(context, editor)).toContain('Choose project folder')
	expect(editor).toBeLessThan(footer)
	expect(footer).toBeLessThan(plus)
	expect(plus).toBeLessThan(permission)
	expect(permission).toBeLessThan(model)
	expect(model).toBeLessThan(submit)
	expect(html.match(/aria-label="Tool permissions"/g)).toHaveLength(1)
	expect(html.match(/aria-label="Select model"/g)).toHaveLength(1)
	expect(html.match(/<textarea\b/g)).toHaveLength(1)
	const trigger = html.slice(model, html.indexOf('</button>', model))
	expect(trigger.indexOf('data-selected-model-icon="anthropic"')).toBeGreaterThan(0)
	expect(trigger.indexOf('data-selected-model-icon="anthropic"')).toBeLessThan(
		trigger.indexOf('<span class="truncate">Claude Sonnet 4.5'),
	)
	expect(html.match(/data-selected-model-icon=/g)).toHaveLength(1)
})

it('shows the wordmark once and only offers installed conversation engines', () => {
	const html = render({
		connected: true,
		harnessView: {
			selected: 'namzu',
			locked: false,
			engines: [
				{ id: 'namzu', label: 'Namzu', available: true },
				{ id: 'codex-cli', label: 'Codex CLI', available: true },
				{ id: 'claude-code', label: 'Claude Code', available: false },
			],
		},
	})
	expect(html).toContain('aria-label="Execution engine"')
	expect(html).toContain('composer-harness-mark')
	expect(html).toContain('Codex CLI')
	expect(html).toContain('Not installed')
	expect(html).not.toContain('Worktree')
	expect(html).not.toContain('type="checkbox"')
	const supplied = render({
		connected: true,
		harnessView: {
			selected: 'claude-code',
			locked: true,
			engines: [{ id: 'claude-code', label: 'Claude Code', available: true }],
		},
		attachmentsSupported: false,
		reviewModes: ['prompt', 'plan'],
	})
	expect(supplied).toContain('Choosing another engine opens a new conversation tab.')
	expect(button(supplied, 'Attach files')).toMatch(/\bdisabled=/)
	expect(supplied).not.toContain('composer-harness-mark')
})

it('retains functional normal attachment, plugin, effort, queue and approval controls', () => {
	const html = render({
		connected: true,
		running: true,
		settings: { permissionMode: 'auto', effort: 'high' },
		capabilities: { effortLevels: ['low', 'high'], effortDefault: 'low' },
		queued: ['Next request'],
		queuedItems: [{ id: 'next', prompt: 'Next request' }],
		attachments: [
			{
				id: 'notes',
				name: 'notes.txt',
				kind: 'text',
				size: 20,
				mediaType: 'text/plain',
			},
		],
		permissions: [
			{
				id: 'review',
				projectId: 'pal-control',
				sessionId: 'owned',
				calls: [
					{
						id: 'call',
						name: 'bash',
						input: { command: 'pwd' },
						isDestructive: false,
					},
				],
			},
		],
	})
	expect(button(html, 'Attach files')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Reasoning effort')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Tool permissions')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Plugins')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Select model')).toMatch(/\bdisabled=/)
	expect(button(html, 'Remove notes.txt')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Remove queued message 1')).not.toMatch(/\bdisabled=/)
	expect(html).toContain('aria-label="Tool approval"')
	expect(html).toContain('Allow once')
	expect(html).toContain('data-composer-permission="auto"')
	expect(button(html, 'Stop turn')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Queue message')).not.toMatch(/\bdisabled=/)
	const offline = render()
	for (const label of ['Attach files', 'Tool permissions', 'Plugins', 'Send message'])
		expect(button(offline, label)).toMatch(/\bdisabled=/)
})

it('offers only actual ordinary projects with current selection and connection/trust hints', () => {
	const html = render({
		connected: true,
		projectId: 'ordinary',
		projectName: 'namzu',
		projects: [
			{
				id: 'ordinary',
				name: 'namzu',
				path: '/owned/namzu',
				trusted: true,
				status: 'ready',
			},
			{
				id: 'other',
				name: 'Needs approval',
				path: '/owned/other',
				trusted: false,
				status: 'connecting',
			},
			{
				id: 'failed',
				name: 'A disconnected project',
				path: '/owned/failed',
				trusted: true,
				status: 'error',
				error: 'Private transport detail',
			},
			{
				id: 'chat',
				name: 'An ordinary chat',
				path: '/owned/chat',
				trusted: true,
				status: 'ready',
				isChat: true,
			},
			{
				id: 'pal-project',
				name: 'Private Pal workspace',
				path: '/owned/private',
				trusted: true,
				status: 'ready',
				palId: 'private-pal',
			},
		],
		onSelectProject: () => {},
	})
	expect(html).toContain('aria-label="Project chooser"')
	expect(html).toContain('aria-label="Available projects"')
	expect(html).toMatch(/aria-checked="true"[^>]*aria-label="namzu"/)
	expect(html).toContain('Approval required · Connecting…')
	expect(html).toContain('Connection error')
	expect(html).toContain('An ordinary chat')
	expect(html).toContain('Open folder…')
	expect(html).not.toContain('Private Pal workspace')
	expect(html).not.toContain('/owned/private')
	expect(html).not.toContain('Private transport detail')
	expect(html).toContain('data-selected-model-icon="remote"')
})

it('retains the folder handler without a supplied project navigation contract', () => {
	const project = {
		id: 'ordinary',
		name: 'namzu',
		path: '/owned/namzu',
		trusted: true,
		status: 'ready' as const,
	}
	for (const override of [{}, { projects: [project] }, { onSelectProject: () => {} }]) {
		const html = render(override)
		expect(html).toContain('aria-label="Choose project folder"')
		expect(html).not.toContain('aria-label="Project chooser"')
	}
})
