/// <reference types="vite/client" />

import type {
	ChatMessage,
	ConversationView,
	DesktopApi,
	DesktopEvent,
	DraftSettings,
	ProjectView,
	ProviderView,
} from '../shared/protocol.js'

// This separate development entry never substitutes for the native preload API.
if (!import.meta.env.DEV || window.namzu)
	throw new Error('The design preview is available only in a development browser.')

const clone = <T>(value: T): T => structuredClone(value)
const sampleDate = '2026-10-01T09:00:00.000Z'
const projects: ProjectView[] = [
	{
		id: 'sample-app',
		name: 'Sample app',
		path: '/sample/app',
		trusted: true,
		status: 'ready',
	},
	{
		id: 'sample-docs',
		name: 'Sample docs',
		path: '/sample/docs',
		trusted: true,
		status: 'ready',
	},
	{
		id: 'sample-workspace',
		name: 'Sample workspace',
		path: '/sample/workspace',
		trusted: true,
		status: 'ready',
	},
]
const titles = [
	['sample-app', 'Refine navigation'],
	['sample-app', 'Polish empty states'],
	['sample-app', 'Review message settings'],
	['sample-docs', 'Improve the quick start'],
	['sample-docs', 'Keep notes readable'],
	['sample-workspace', 'Explore a new idea'],
] as const
const conversations: ConversationView[] = titles.map(([projectId, title], index) => ({
	id: `sample-thread-${index + 1}`,
	projectId,
	title,
	updatedAt: sampleDate,
}))
const messages = new Map<string, ChatMessage[]>(
	conversations.map((conversation) => [
		conversation.id,
		[
			{
				role: 'user',
				text: `Let’s work on ${conversation.title.toLowerCase()}.`,
			},
			{
				role: 'assistant',
				text: '**Sample conversation**\n\nThis content is here to review the interface.\n\n- Navigate between projects and conversations.\n- Try the model picker, message settings and appearance.\n- Draft a follow-up without contacting a model.',
			},
		],
	]),
)
const drafts = new Map<string, string>()
const settings = new Map<string, DraftSettings>()
const selections = new Map<string, ProviderView['selected']>()
const listeners = new Set<(event: DesktopEvent) => void>()
const available: ProviderView['available'] = [
	{
		id: 'anthropic',
		label: 'Sample provider',
		defaultModel: 'sample-balanced',
	},
	{
		id: 'sample-local',
		label: 'Sample local models',
		defaultModel: 'sample-focused',
	},
]
let nextConversation = conversations.length + 1

function project(id: string): ProjectView {
	const found = projects.find((item) => item.id === id)
	if (!found) throw new Error('Choose a sample project in this design preview.')
	return found
}
function conversation(id: string): ConversationView {
	const found = conversations.find((item) => item.id === id)
	if (!found) throw new Error('Choose a sample conversation in this design preview.')
	return found
}
function owner(id: string): void {
	if (id.startsWith('project:')) project(id.slice('project:'.length))
	else conversation(id)
}
function nativeOnly(action: string): never {
	throw new Error(
		`${action} is available in the desktop app. This design preview uses only sample data.`,
	)
}

const api: DesktopApi = {
	windowChrome: async () => ({ platform: 'other', height: 32 }),
	setWindowAppearance: async () => {},
	popupWindowMenu: async () => nativeOnly('Native window menus'),
	projects: async () => clone(projects),
	openProject: async () => nativeOnly('Opening a device folder'),
	reconnectProject: async () => nativeOnly('Connecting a real project'),
	trustProject: async () => nativeOnly('Granting device folder access'),
	conversations: async (id) => {
		project(id)
		return clone(conversations.filter((item) => item.projectId === id))
	},
	newConversation: async (id) => {
		project(id)
		const view: ConversationView = {
			id: `sample-thread-${nextConversation++}`,
			projectId: id,
			title: 'Sample draft',
			updatedAt: sampleDate,
		}
		conversations.unshift(view)
		messages.set(view.id, [])
		return clone(view)
	},
	openConversation: async (projectId, id) => {
		project(projectId)
		if (conversation(id).projectId !== projectId)
			throw new Error('This sample conversation belongs to another project.')
		return { messages: clone(messages.get(id) ?? []), partial: false }
	},
	providers: async (projectId, id) => {
		project(projectId)
		if (id && conversation(id).projectId !== projectId)
			throw new Error('This sample conversation belongs to another project.')
		return {
			available: clone(available),
			selected: clone(
				(id && selections.get(id)) || {
					id: 'anthropic',
					model: 'sample-balanced',
				},
			),
		}
	},
	models: async (projectId, provider) => {
		project(projectId)
		if (!available.some((item) => item.id === provider))
			throw new Error('Choose a sample provider.')
		return {
			models: [
				{
					id: 'sample-balanced',
					label: 'Sample balanced',
					note: 'Preview model',
				},
				{
					id: 'sample-focused',
					label: 'Sample focused',
					note: 'Preview model',
				},
				{ id: 'sample-quick', label: 'Sample quick', note: 'Preview model' },
			],
			notice: 'Sample model catalogue. No provider is connected.',
		}
	},
	modelSettings: async (projectId) => {
		project(projectId)
		return {
			effortLevels: ['low', 'medium', 'high'],
			effortDefault: 'medium',
			notice: 'These are sample capabilities for design review.',
		}
	},
	plugins: async (projectId) => {
		project(projectId)
		return {
			plugins: [],
			live: false,
			canChange: false,
			notice: 'No plugin runtime is connected in this design preview.',
		}
	},
	setPluginEnabled: async () => nativeOnly('Changing runtime plugins'),
	selectProvider: async (id, provider, model) => {
		conversation(id)
		if (!available.some((item) => item.id === provider))
			throw new Error('Choose a sample provider.')
		selections.set(id, { id: provider, ...(model ? { model } : {}) })
	},
	pickAttachments: async () => nativeOnly('Picking files'),
	addAttachments: async () => nativeOnly('Attaching device files'),
	attachments: async (id) => {
		owner(id)
		return []
	},
	removeAttachment: async () => nativeOnly('Changing device files'),
	moveAttachments: async (from, to) => {
		owner(from)
		conversation(to)
		return []
	},
	send: async () => {
		throw new Error(
			'This is a design preview. No message was sent to a model. Open the desktop app to run real work.',
		)
	},
	draft: async (id) => {
		owner(id)
		return drafts.get(id) ?? ''
	},
	saveDraft: async (id, value) => {
		owner(id)
		drafts.set(id, value)
	},
	draftSettings: async (id) => {
		owner(id)
		return clone(settings.get(id) ?? {})
	},
	saveDraftSettings: async (id, value) => {
		owner(id)
		settings.set(id, clone(value))
	},
	cancel: async () => nativeOnly('Stopping model work'),
	takeQueued: async () => nativeOnly('Editing real queued work'),
	removeQueued: async () => nativeOnly('Removing real queued work'),
	approve: async () => nativeOnly('Approving a real tool call'),
	jobs: async (id) => {
		conversation(id)
		return []
	},
	readJob: async () => nativeOnly('Reading a background process'),
	stopJob: async () => nativeOnly('Stopping a background process'),
	onEvent: (listener) => {
		listeners.add(listener)
		return () => listeners.delete(listener)
	},
}

window.namzu = api
const banner = document.createElement('aside')
banner.setAttribute('role', 'status')
banner.setAttribute('aria-label', 'Design preview')
banner.textContent = 'Design preview · sample data'
banner.title = 'Sample data only. No model, credentials or device access. Changes remain in memory.'
Object.assign(banner.style, {
	position: 'fixed',
	top: '6px',
	right: '12px',
	zIndex: '2000',
	pointerEvents: 'none',
	padding: '2px 7px',
	borderRadius: '5px',
	font: '11px/16px var(--font-sans)',
	color: 'var(--muted-foreground)',
	background: 'var(--chrome)',
})
document.body.append(banner)
await import('../renderer/index.js')
