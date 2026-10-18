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
	expect(pal).not.toContain('data-slot="composer-context-strip"')
	expect(pal).not.toContain('What would you like to work on?')
	expect(pal).not.toContain('Ideas to get started')
	const standard = render({ empty: true })
	expect(standard).toContain('data-composer-variant="default"')
	expect(standard).toContain('data-slot="composer-context-strip"')
	expect(standard).toContain('What would you like to work on?')
	expect(standard).toContain('placeholder="Ask Namzu anything"')
	expect(render({ empty: true, emptyHeading: 'What should we work on in demo?' })).toContain(
		'What should we work on in demo?',
	)
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
	for (const detail of ['Run this command?', 'pwd', 'Accept', 'Reject', 'Edit'])
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

it('keeps real context above the normal editor and permissions beside Plus below it', () => {
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
	const context = html.indexOf('data-slot="composer-context-strip"')
	const editor = html.indexOf('<textarea')
	const footer = html.indexOf('data-chat-composer-footer')
	const plus = html.indexOf('aria-label="Attachments and message settings"', footer)
	const permission = html.indexOf('aria-label="Permissions: ', footer)
	const model = html.indexOf('aria-label="Model: Claude Sonnet 4.5"', footer)
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
	// The engine lives in the model popup now; the tray above the box has no chip.
	expect(html).not.toContain('aria-label="Execution engine"')
	expect(html).toContain('aria-label="Engine: Namzu"')
	expect(html).toContain('composer-harness-mark')
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
	expect(supplied).toContain('aria-label="Engine: Claude Code"')
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
	expect(button(html, 'Model: space-bunny-free, effort: High')).toMatch(/\bdisabled=/)
	expect(button(html, 'Remove notes.txt')).not.toMatch(/\bdisabled=/)
	expect(html).toContain('aria-label="Tool approval"')
	expect(html).toContain('Accept')
	expect(html).toContain('data-composer-permission="auto"')
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
	expect(button(codex, 'Engine: Codex CLI')).toMatch(/\bdisabled=/)
	expect(codex).toContain('title="Codex CLI"')
	expect(codex).toContain('Full access')
	expect(codex).not.toContain('>Allow tools<')
	const nativeEngine = render({
		connected: true,
		permissionEngine: 'claude-code',
		settings: { permissionMode: 'prompt' },
	})
	expect(nativeEngine).toContain('title="Claude Code"')
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
	expect(render({ empty: true })).toContain('data-slot="composer-context-strip"')
	expect(render({ empty: false })).not.toContain('data-slot="composer-context-strip"')
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
