import { readFileSync } from 'node:fs'
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
			pending: { rows: [] },
			trayActions: { onSendNow() {}, onSave: async () => {}, onRemove() {}, canSendNow: true },
			onSend: () => {},
			onStop: () => {},
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

const waiting = (text: string) => ({
	id: text,
	kind: 'queued' as const,
	text,
	note: 'After this reply',
	editable: true,
})

function button(html: string, label: string): string {
	// The permission chip's name carries the current mode, so it is matched by prefix.
	const name = label === 'Permissions' ? 'Permissions: [^"]*' : label
	const tag = html.match(new RegExp(`<button\\b[^>]*aria-label="${name}"[^>]*>`))?.[0]
	if (!tag) throw new Error(`Missing ${label} button`)
	return tag
}

it('allows Pal model browsing before computer admission while Send remains disabled', () => {
	const html = render({ modelSelectionReady: true })
	expect(button(html, 'Model: space-bunny-free')).not.toMatch(/\bdisabled(?:=|\s|>)/)
	expect(button(html, 'Send message')).toMatch(/\bdisabled=/)
})

it('blocks model selection before its own catalogue context is ready', () => {
	expect(
		button(render({ connected: true, modelSelectionReady: false }), 'Model: space-bunny-free'),
	).toMatch(/\bdisabled=/)
})

it('keeps model selection blocked during active work and sending', () => {
	for (const work of [{ running: true }, { sending: true }]) {
		expect(
			button(render({ modelSelectionReady: true, ...work }), 'Model: space-bunny-free'),
		).toMatch(/\bdisabled=/)
	}
})

it('keeps an empty provider collection disabled even with catalogue readiness', () => {
	const html = render({
		modelSelectionReady: true,
		providers: { available: [], selected: null },
	})
	expect(button(html, 'Model: no provider connected')).toMatch(/\bdisabled=/)
})

it('preserves ordinary composer readiness when no separate catalogue guard is supplied', () => {
	expect(button(render(), 'Model: space-bunny-free')).toMatch(/\bdisabled=/)
	expect(button(render({ connected: true }), 'Model: space-bunny-free')).not.toMatch(
		/\bdisabled(?:=|\s|>)/,
	)
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
	expect(pal).not.toContain('composer-row-project')
	expect(pal).not.toContain('data-composer-row')
	expect(pal).not.toContain('What would you like to work on?')
	expect(pal).not.toContain('Ideas to get started')
	const standard = render({ empty: true })
	expect(standard).toContain('data-composer-variant="default"')
	expect(standard).toContain('composer-row-project')
	expect(standard).toContain('data-composer-row')
	expect(standard).toContain('What would you like to work on?')
	expect(standard).toContain('placeholder="Ask Namzu anything"')
	expect(render({ empty: true, emptyHeading: 'What should we work on in demo?' })).toContain(
		'What should we work on in demo?',
	)
})

it('draws a covered project name in the display face and any other whole name in the interface face', () => {
	const parts = (name: string) => ({ before: 'What should we work on in ', name, after: '?' })
	const covered = render({ empty: true, emptyHeadingParts: parts('harbor-api') })
	expect(covered).toContain(
		'What should we work on in <span class="home-heading-name" data-face="display">harbor-api</span>?',
	)
	const uncovered = render({ empty: true, emptyHeadingParts: parts('harbor-проект') })
	expect(uncovered).toContain(
		'<span class="home-heading-name" data-face="interface">harbor-проект</span>',
	)
	expect(uncovered).not.toContain('data-face="display"')
})

it('keeps the Pal Plus menu and actual model available while computer execution is offline', () => {
	const html = render({ variant: 'pal', modelSelectionReady: true })
	expect(button(html, 'Attachments and message settings')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Model: space-bunny-free')).not.toMatch(/\bdisabled=/)
	expect(html.match(/aria-label="Model: /g)).toHaveLength(1)
	expect(button(html, 'Attach files')).toMatch(/\bdisabled=/)
	expect(button(html, 'Permissions')).toMatch(/\bdisabled=/)
	expect(button(html, 'Plugins')).toMatch(/\bdisabled=/)
	expect(button(html, 'Send message')).toMatch(/\bdisabled=/)
	for (const work of [{ running: true }, { sending: true }])
		expect(
			button(
				render({ variant: 'pal', modelSelectionReady: true, ...work }),
				'Model: space-bunny-free',
			),
		).toMatch(/\bdisabled=/)
})

it('admits Pal chat and model attachments without granting unavailable guest tools or host plugins', () => {
	const html = render({
		variant: 'pal',
		connected: true,
		modelSelectionReady: true,
		toolsAvailable: false,
		pluginsSupported: false,
	})
	for (const label of ['Send message', 'Attach files', 'Model: space-bunny-free'])
		expect(button(html, label)).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Permissions')).toMatch(/\bdisabled=/)
	expect(html).not.toContain('aria-label="Plugins"')
	const standard = render({ connected: true })
	expect(button(standard, 'Plugins')).not.toMatch(/\bdisabled=/)
	const online = render({
		variant: 'pal',
		connected: true,
		toolsAvailable: true,
		pluginsSupported: false,
	})
	expect(button(online, 'Permissions')).not.toMatch(/\bdisabled=/)
})

it('keeps approval details readable but disables action decisions when guest authority is absent', () => {
	const permission: ComponentProps<typeof Composer>['permissions'][number] = {
		id: 'approval',
		sessionId: 'conversation',
		projectId: 'pal-control',
		calls: [{ id: 'call', name: 'guest.bash', input: { command: 'pwd' }, isDestructive: false }],
	}
	const unavailable = render({
		variant: 'pal',
		connected: true,
		toolsAvailable: false,
		permissions: [permission],
	})
	expect(
		unavailable.match(/<fieldset\b[^>]*aria-label="Action approval controls"[^>]*>/)?.[0],
	).toMatch(/\bdisabled=/)
	for (const detail of ['Run', 'pwd', 'Accept', 'Reject', 'More about this request'])
		expect(unavailable).toContain(detail)
	expect(button(unavailable, 'Send message')).not.toMatch(/\bdisabled=/)
	for (const guard of [
		{ toolsAvailable: false },
		{ connected: false },
		{ draftDisabled: true },
		{ harnessBusy: true },
	]) {
		const html = render({ connected: true, permissions: [permission], ...guard })
		expect(html.match(/<fieldset\b[^>]*aria-label="Action approval controls"[^>]*>/)?.[0]).toMatch(
			/\bdisabled=/,
		)
	}
	const admitted = render({ connected: true, toolsAvailable: true, permissions: [permission] })
	expect(
		admitted.match(/<fieldset\b[^>]*aria-label="Action approval controls"[^>]*>/)?.[0],
	).not.toMatch(/\bdisabled=/)
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
		pending: { rows: [waiting('Later request')] },
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
	expect(html).toContain('aria-label="Tool approval"')
	expect(html).toContain('pwd')
	expect(html).toContain('Accept')
	expect(button(html, 'Stop reply')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Queue message')).not.toMatch(/\bdisabled=/)
})

it('keeps restored work readable without admitting queue or turn mutations during hydration', () => {
	const work = {
		variant: 'pal' as const,
		connected: true,
		draft: '',
		running: true,
		pending: { rows: [waiting('Retained queued request')] },
		attachments: [
			{ id: 'file', name: 'notes.txt', kind: 'text' as const, size: 20, mediaType: 'text/plain' },
		],
	}
	const pending = render({ ...work, draftDisabled: true })
	for (const label of ['Stop reply', 'Remove notes.txt']) {
		expect(button(pending, label)).toMatch(/\bdisabled=/)
		expect(button(render(work), label)).not.toMatch(/\bdisabled=/)
	}
})

it('holds only the text, Plus and Send in the box, and the settings in one row under it', () => {
	const html = render({
		connected: true,
		empty: true,
		projectName: 'namzu',
		computerLabel: 'This computer',
		choice: {
			provider: 'zen',
			model: 'claude-sonnet-4-5',
			label: 'Claude Sonnet 4.5',
		},
	})
	const editor = html.indexOf('<textarea')
	const footer = html.indexOf('data-chat-composer-footer')
	const plus = html.indexOf('aria-label="Attachments and message settings"', footer)
	const submit = html.indexOf('aria-label="Send message"', footer)
	const row = html.indexOf('data-composer-row')
	const project = html.indexOf('This computer', row)
	const permission = html.indexOf('aria-label="Permissions: ', row)
	const model = html.indexOf('aria-label="Model: Claude Sonnet 4.5"', row)
	expect(editor).toBeLessThan(footer)
	expect(footer).toBeLessThan(plus)
	expect(plus).toBeLessThan(submit)
	// The row is outside the box, after it, in this order: project, permission mode, model.
	expect(submit).toBeLessThan(row)
	expect(row).toBeLessThan(project)
	expect(project).toBeLessThan(permission)
	expect(permission).toBeLessThan(model)
	expect(html.slice(row)).toContain('Choose project folder')
	// Nothing of the settings is left inside the box.
	const box = html.slice(html.indexOf('data-chat-composer-main-surface'), row)
	expect(box).not.toContain('Permissions: ')
	expect(box).not.toContain('aria-label="Model: ')
	expect(box).not.toContain('Choose project folder')
	expect(html.match(/aria-label="Permissions: /g)).toHaveLength(1)
	expect(html.match(/aria-label="Model: /g)).toHaveLength(1)
	expect(html.match(/<textarea\b/g)).toHaveLength(1)
	const trigger = html.slice(model, html.indexOf('</button>', model))
	// The trigger is text only: the model name, with no provider glyph.
	expect(trigger).toContain(
		'<span class="model-picker-trigger-model truncate">Claude Sonnet 4.5</span>',
	)
	expect(html).not.toContain('data-selected-model-icon')
})

it('keeps the project line out of the row once the conversation has begun, and the context at its end', () => {
	const usage = { contextTokens: 28_000, contextWindowTokens: 200_000, cost: 0.06 }
	const html = render({ connected: true, empty: false, projectName: 'namzu', usage })
	const row = html.indexOf('data-composer-row')
	expect(row).toBeGreaterThan(0)
	expect(html).not.toContain('Choose project folder')
	const permission = html.indexOf('aria-label="Permissions: ', row)
	const model = html.indexOf('aria-label="Model: ', row)
	const context = html.indexOf('data-context-ring=', row)
	expect(permission).toBeGreaterThan(row)
	expect(model).toBeGreaterThan(permission)
	expect(context).toBeGreaterThan(model)
	expect(html.slice(context)).toContain('14% · $0.06')
	// With no measured context nothing takes the ring's place.
	expect(render({ connected: true, empty: false, projectName: 'namzu' })).not.toContain(
		'data-context-ring=',
	)
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
	// The engine lives behind the model popup's More row now; neither the tray nor the first view has a chip.
	expect(html).not.toContain('aria-label="Execution engine"')
	expect(html).not.toContain('aria-label="Engine: Namzu"')
	expect(html).not.toContain('composer-harness-mark')
	expect(html).toContain('More<small>: engine</small>')
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
	expect(button(supplied, 'Attach files')).toMatch(/\bdisabled=/)
	expect(supplied).not.toContain('composer-harness-mark')
})

it('retains functional normal attachment, plugin, effort, queue and approval controls', () => {
	const html = render({
		connected: true,
		running: true,
		settings: { permissionMode: 'auto', effort: 'high' },
		capabilities: { effortLevels: ['low', 'high'], effortDefault: 'low' },
		pending: { rows: [waiting('Next request')] },
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
	expect(button(html, 'Permissions')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Plugins')).not.toMatch(/\bdisabled=/)
	// The row keeps the model at its right while the card waits; it cannot change while a reply runs, so it is disabled.
	expect(html).toContain('aria-label="Model: space-bunny-free')
	expect(html).toContain('composer-waiting')
	expect(button(html, 'Remove notes.txt')).not.toMatch(/\bdisabled=/)
	expect(html).toContain('aria-label="Tool approval"')
	expect(html).toContain('Accept')
	// Saved as the old Full access id (`auto`), shown as Full access (`bypass`).
	expect(html).toContain('data-composer-permission="bypass"')
	expect(button(html, 'Stop reply')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Queue message')).not.toMatch(/\bdisabled=/)
	const offline = render()
	for (const label of ['Attach files', 'Permissions', 'Plugins', 'Send message'])
		expect(button(offline, label)).toMatch(/\bdisabled=/)
	const idle = render({
		connected: true,
		capabilities: { effortLevels: ['low', 'high'], effortDefault: 'low' },
	})
	expect(button(idle, 'Model: space-bunny-free, effort: Low')).not.toMatch(/\bdisabled=/)
	const tools = idle.slice(
		idle.indexOf('<div aria-label="Attachments and message settings">'),
		idle.indexOf('<div aria-label="Model picker">'),
	)
	expect(tools).not.toContain('aria-label="Reasoning effort"')
})

it('offers only actual ordinary projects with current selection and connection/trust hints', () => {
	const html = render({
		connected: true,
		empty: true,
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
		onLeaveProject: () => {},
		onCreateProject: () => {},
	})
	expect(html).toContain('aria-label="Project chooser"')
	expect(html).toContain('aria-label="Available projects"')
	expect(html).toMatch(/aria-checked="true"[^>]*aria-label="namzu"/)
	expect(html).toContain('Folder access required')
	expect(html).toContain('Connecting…')
	expect(html).toContain('Connection error')
	expect(html).not.toContain('An ordinary chat')
	expect(html).toContain('Don’t work in a project')
	expect(html).toContain('Use an existing folder')
	expect(html).toContain('Start from scratch')
	expect(html).toContain('aria-label="Search projects"')
	expect(html).not.toContain('Private Pal workspace')
	expect(html).not.toContain('/owned/private')
	expect(html).not.toContain('Private transport detail')
	expect(html).not.toContain('data-selected-model-icon')
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
		const html = render({ ...override, empty: true })
		expect(html).toContain('aria-label="Choose project folder"')
		expect(html).not.toContain('aria-label="Project chooser"')
	}
})

it('retains confirmed native engine and permission semantics without optional engine metadata', () => {
	const codex = render({
		connected: true,
		permissionEngine: 'codex-cli',
		permissionScope: 'native-conversation',
		settings: { permissionMode: 'auto' },
	})
	expect(codex).toContain('Full access')
	expect(codex).not.toContain('>Allow tools<')
	const nativeEngine = render({
		connected: true,
		permissionEngine: 'claude-code',
		settings: { permissionMode: 'prompt' },
	})
	expect(nativeEngine).toContain('aria-label="Permissions: Ask first"')
})

const file = {
	id: 'file',
	name: 'Notes.txt',
	kind: 'text' as const,
	size: 10,
	mediaType: 'text/plain',
}

it('keeps attachments removable but blocks Send on an engine without attachments', () => {
	const html = render({
		connected: true,
		attachments: [file],
		attachmentsSupported: false,
	})
	expect(html).toContain('Remove attachments to send with this engine.')
	expect(button(html, 'Send message')).toMatch(/\bdisabled=/)
	expect(button(html, 'Remove Notes.txt')).not.toMatch(/\bdisabled=/)
	const supported = render({ connected: true, attachments: [file] })
	expect(supported).not.toContain('Remove attachments to send')
	expect(button(supported, 'Send message')).not.toMatch(/\bdisabled=/)
})

it('shows the tray only while the conversation is empty', () => {
	expect(render({ empty: true })).toContain('composer-row-project')
	expect(render({ empty: false })).not.toContain('composer-row-project')
})

it('draws no model prompt or raw id while the model choice is still resolving', () => {
	const html = render({ modelSelectionReady: false, modelPending: true })
	expect(html).toContain('model-picker-trigger-skeleton')
	expect(html).not.toContain('Select model')
	expect(html).not.toContain('Model: space-bunny-free')
})

const freeOnly = {
	available: [
		{
			id: 'zen',
			label: 'Zen',
			defaultModel: 'space-bunny-free',
			anonymous: true as const,
			via: 'free' as const,
		},
	],
	selected: null,
}

it('is ready on first open with only the free Zen models: no card, Send enabled, a plain note', () => {
	const html = render({
		providers: { ...freeOnly, selected: { id: 'zen', automatic: true as const } },
		connected: true,
		empty: true,
		choiceUnchosen: true,
		draft: 'make me a small website',
		onOpenModelSettings: () => {},
	})
	expect(html).not.toContain('Add an API key or sign in to start')
	expect(html).not.toContain('Connect a provider')
	expect(button(html, 'Send message')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Send message')).not.toMatch(/aria-disabled=/)
	expect(html).toContain('Using Zen&#x27;s free models (experimental).')
	expect(html).not.toContain('space-bunny-free</p>')
})

it('shows the starter ideas on first open with only the free models and an empty box', () => {
	const html = render({
		providers: { ...freeOnly, selected: { id: 'zen', automatic: true as const } },
		connected: true,
		empty: true,
		draft: '',
	})
	expect(html).toContain('Ideas to get started')
	expect(html).not.toContain('Add an API key or sign in to start')
})

it('still tells a first-timer to add a key or sign in when truly nothing is available', () => {
	const html = render({
		providers: { available: [], selected: null },
		connected: true,
		empty: true,
		draft: 'make me a small website',
		onOpenModelSettings: () => {},
	})
	expect(html).toContain('Add an API key or sign in to start')
	expect(html).toContain('Connect a provider')
	expect(html).not.toContain('Ideas to get started')
	expect(html).not.toContain('Namzu terminal app')
	expect(button(html, 'Send message')).toMatch(/\bdisabled=/)
})

it('keeps the empty state away once a provider is connected, and while providers still load', () => {
	const connected = render({ connected: true, empty: true, draft: '' })
	expect(connected).not.toContain('Add an API key or sign in to start')
	expect(connected).toContain('Ideas to get started')
	const loading = render({
		providers: { available: [], selected: null },
		providersLoading: true,
		empty: true,
	})
	expect(loading).not.toContain('Add an API key or sign in to start')
})

it('names the shortcut that takes the newest waiting message back, only while one waits', () => {
	expect(render({ pending: { rows: [waiting('Later')] }, draft: '' })).toContain(
		'Press ↑ to edit queued messages',
	)
	expect(render({ pending: { rows: [] }, draft: '' })).not.toContain(
		'Press ↑ to edit queued messages',
	)
	expect(render({ pending: { rows: [waiting('Later')] }, draft: 'typing' })).not.toContain(
		'Press ↑ to edit queued messages',
	)
})

it('queues with an icon, not a text button, while a reply takes live input', () => {
	const html = render({ running: true, liveInputSupported: true, onQueue: () => {}, draft: 'x' })
	const tag = button(html, 'Queue message for the next reply')
	expect(tag).not.toMatch(/\bdisabled=/)
	expect(html).not.toMatch(/>\s*Queue message\s*</)
})

it('draws the waiting messages in a tray joined to the composer, with their actions', () => {
	const html = render({ running: true, pending: { rows: [waiting('First'), waiting('Second')] } })
	expect(html).toContain('data-composer-tray')
	expect(html).toContain('2 waiting')
	expect(html).toContain('composer-with-tray')
	expect(button(html, 'Send now: First')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Edit: Second')).not.toMatch(/\bdisabled=/)
	expect(button(html, 'Remove: Second')).not.toMatch(/\bdisabled=/)
	expect(render({ pending: { rows: [] } })).not.toContain('data-composer-tray')
})

it('shows how many shells run and the branch pull request, quietly, beside the mode', () => {
	const none = render({})
	expect(none).not.toContain('data-composer-shells')
	expect(none).not.toContain('data-composer-pr')
	const html = render({
		shells: { count: 2, onOpen: () => {} },
		pullRequest: {
			pr: { number: 607, url: 'https://github.com/o/r/pull/607', review: 'changes' },
			onOpen: () => {},
		},
	})
	expect(html).toContain('>2 shells<')
	expect(html).toContain('2 background shells running. Show')
	expect(html).toContain('>PR #607<')
	expect(html).toContain('data-review="changes"')
	expect(html).toContain('Pull request 607, changes requested. Open in browser')
	expect(render({ shells: { count: 1, onOpen: () => {} } })).toContain('>1 shell<')
})

it('teaches the send and hold keys in the empty box while a reply runs', () => {
	const live = render({ running: true, liveInputSupported: true, draft: '', onQueue: () => {} })
	expect(live).toMatch(
		/placeholder="Enter sends now · (?:Ctrl|Cmd)\+Enter or Tab sends after this reply"/,
	)
	const plain = render({ running: true, draft: '' })
	expect(plain).toContain('placeholder="Enter sends after this reply"')
})

it('turns Stop into a "Stopping" state until the reply ends', () => {
	const stop = button(render({ running: true, draft: '' }), 'Stop reply')
	expect(stop).not.toContain('data-stopping')
	const stopping = render({ running: true, stopping: true, draft: '' })
	const tag = button(stopping, 'Stopping reply')
	expect(tag).toContain('aria-busy="true"')
	expect(tag).toContain('data-stopping="true"')
	// The square gives way to the spinner, and the label no longer offers to stop.
	expect(stopping).not.toContain('aria-label="Stop reply"')
	expect(stopping).toContain('composer-send-spinner')
})

it('shows no Stopping state once the reply is over', () => {
	const html = render({ running: false, stopping: true, draft: 'next' })
	expect(html).not.toContain('Stopping reply')
})

it("keeps the model in the row while an approval waits, and closes the project line's room as it leaves", () => {
	const html = render({
		connected: true,
		empty: false,
		permissions: [
			{
				id: 'approval',
				sessionId: 'conversation',
				projectId: 'p',
				calls: [{ id: 'call', name: 'bash', input: { command: 'pwd' }, isDestructive: false }],
			},
		],
	})
	const row = html.indexOf('data-composer-row')
	expect(html.indexOf('aria-label="Model: ', row)).toBeGreaterThan(row)
	const css = readFileSync(new URL('./composer.css', import.meta.url), 'utf8')
	// The project line collapses its width while it fades, so the mode slides instead of jumping on unmount.
	expect(css).toMatch(
		/@keyframes composer-row-project-out \{\s*from \{\s*grid-template-columns: minmax\(0, 1fr\);/,
	)
})

it('keeps the row quiet and in its place: no fill or border at rest, the mode never shrinks, the percentage goes first', () => {
	const css = readFileSync(new URL('./composer.css', import.meta.url), 'utf8')
	// The box's corners are 16px, from the panel radius token.
	expect(css).toMatch(
		/\.normal-composer-shell \[data-slot="composer-host"\],[\s\S]*?border-radius: var\(--radius-panel\)/,
	)
	// The mode is never cut; the model's own name takes the ellipsis; the row wraps only when very narrow.
	expect(css).toMatch(/\.composer-row \.composer-permission-control \{\s*flex: none;/)
	expect(css).toMatch(/\.composer-row-end \{\s*flex: 0 2 auto;/)
	expect(css).toMatch(
		/@container composer-row \(max-width: 520px\) \{\s*\.composer-row \.context-readout-text \{\s*display: none;/,
	)
	expect(css).toMatch(
		/@container composer-row \(max-width: 360px\) \{\s*\.composer-row-inner \{\s*flex-wrap: wrap;/,
	)
	// Every chevron keeps its room at rest, so the row never shifts under the pointer.
	expect(css).toMatch(
		/\.composer-project-control \[data-composer-control-chevron\] \{\s*width: 12px;[\s\S]*?opacity: 0;/,
	)
	expect(css).not.toContain('composer-context-above')
	expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
})
