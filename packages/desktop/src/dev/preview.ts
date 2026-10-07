/// <reference types="vite/client" />

import { copyTextPayload } from '../shared/clipboard-text.js'
import type {
	ChatMessage,
	ConversationView,
	DesktopApi,
	DesktopEvent,
	DraftSettings,
	PalView,
	ProjectView,
	ProviderView,
	WorkspaceView,
} from '../shared/protocol.js'
import {
	activateWorkspaceTab,
	closeWorkspaceTab,
	moveWorkspaceTab,
	openWorkspaceTab,
	resizeWorkspaceSplit,
} from '../shared/workspace-layout.js'

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
const pals: PalView[] = []
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
				text: '**Sample conversation**\n\nThis content is here to review the interface.\n\n- Navigate between projects and conversations.\n- Try the model picker, message settings and appearance.\n- Draft a follow-up without contacting a model.\n\nSources to hover: [A rich page](https://example.test/rich), [A page with no details](https://example.test/plain), [A slow page](https://example.test/slow), and a bare address `https://example.test/rich`.',
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
function owner(value: string): void {
	// Pane drafts are keyed `project:<id>:workspace:<window>:<group>`.
	const id = value.replace(/:workspace:.*$/, '')
	if (id.startsWith('project:')) project(id.slice('project:'.length))
	else conversation(id)
}
// One in-memory window whose panes use the app's own layout operations.
const windowId = 'preview-window'
const workspace: WorkspaceView = {
	windowId,
	sequence: 0,
	homeGroupId: 'preview-home',
	layout: {
		version: 1,
		revision: 0,
		windows: [
			{
				id: windowId,
				focusedGroupId: 'preview-home',
				root: {
					kind: 'group',
					id: 'preview-home',
					tabs: ['sample-thread-1', 'sample-thread-2'],
					activeTabId: 'sample-thread-1',
				},
			},
		],
	},
}
let nextGroup = 1
function commitLayout(next: WorkspaceView['layout'] | null): WorkspaceView {
	if (next && next !== workspace.layout) {
		workspace.layout = { ...next, revision: workspace.layout.revision + 1 }
		workspace.sequence++
		const view = clone(workspace)
		for (const listener of listeners) listener({ kind: 'workspace', view })
	}
	return clone(workspace)
}
function nativeOnly(action: string): never {
	throw new Error(
		`${action} is available in the desktop app. This design preview uses only sample data.`,
	)
}

const api: DesktopApi = {
	copyText: async (text) => {
		const value = copyTextPayload(text)
		if (!navigator.clipboard?.writeText)
			throw new Error('Clipboard access is unavailable in this browser.')
		await navigator.clipboard.writeText(value)
	},
	windowChrome: async () => ({ platform: 'other', height: 32 }),
	workspace: async () => clone(workspace),
	workspaceReady: async () => clone(workspace),
	workspaceCloseReady: async () => {},
	workspaceAction: async (action) => {
		const layout = workspace.layout
		switch (action.kind) {
			case 'open': {
				const found = layout.windows[0]?.root
				return commitLayout(
					openWorkspaceTab(layout, {
						windowId,
						tabId: action.tabId,
						groupId: action.groupId ?? (found?.kind === 'group' ? found.id : undefined),
						newGroupId: `preview-group-${nextGroup++}`,
					}) ??
						(action.groupId
							? activateWorkspaceTab(layout, {
									windowId,
									groupId: action.groupId,
									tabId: action.tabId,
								})
							: null),
				)
			}
			case 'activate':
				return commitLayout(activateWorkspaceTab(layout, { windowId, ...action }))
			case 'close':
				return commitLayout(closeWorkspaceTab(layout, { windowId, ...action }))
			case 'focus':
				return clone(workspace)
			case 'resize':
				return commitLayout(resizeWorkspaceSplit(layout, { windowId, ...action }))
			case 'move':
				return commitLayout(
					moveWorkspaceTab(layout, {
						tabId: action.tabId,
						sourceWindowId: windowId,
						sourceGroupId: action.sourceGroupId,
						targetWindowId: windowId,
						targetGroupId: action.targetGroupId,
						position: action.position,
						...(action.index === undefined ? {} : { index: action.index }),
						newGroupId: `preview-group-${nextGroup++}`,
						newSplitId: `preview-split-${nextGroup++}`,
						...(action.size ? { targetSize: action.size } : {}),
					}),
				)
			case 'detach':
				return nativeOnly('Moving a conversation to a new window')
			default:
				return clone(workspace)
		}
	},
	setWindowAppearance: async () => {},
	popupWindowMenu: async () => nativeOnly('Native window menus'),
	projects: async () => clone(projects),
	pals: async () => clone(pals),
	palProviders: async () => ({
		available: clone(available),
		selected: { id: 'anthropic', model: 'sample-balanced' },
	}),
	palModels: async (provider) => api.models('sample-app', provider),
	createPal: async (input) => {
		if (!input.name.trim() || input.name.trim().length > 80)
			throw new Error('Enter a Pal name, up to 80 characters.')
		const id = `sample-pal-${pals.length + 1}`
		const value: PalView = {
			id,
			name: input.name.trim(),
			purpose: input.purpose?.trim() ?? '',
			model: input.model ?? null,
			appearance: input.appearance,
			paused: false,
			revision: 1,
			workspace: `/sample/pals/${id}`,
			createdAt: sampleDate,
			updatedAt: sampleDate,
		}
		pals.push(value)
		projects.push({
			id: `project-${id}`,
			name: value.name,
			path: value.workspace,
			trusted: true,
			status: 'ready',
			palId: id,
		})
		return clone(value)
	},
	updatePal: async (id, expectedRevision, changes) => {
		const value = pals.find((item) => item.id === id)
		if (!value || value.revision !== expectedRevision)
			throw new Error('This sample Pal changed. Open customization again.')
		Object.assign(value, changes, { revision: value.revision + 1 })
		return clone(value)
	},
	openPal: async (id) => {
		const value = pals.find((item) => item.id === id)
		const space = projects.find((item) => item.palId === id)
		if (!value || !space) throw new Error('Choose a sample Pal.')
		space.name = value.name
		return clone({
			pal: value,
			project: space,
			conversations: conversations.filter((item) => item.palId === id),
		})
	},
	palComputer: async () => ({
		status: 'unavailable',
	}),
	startPalComputer: async () => nativeOnly('Starting a Pal virtual computer'),
	stopPalComputer: async () => nativeOnly('Stopping a Pal virtual computer'),
	palScreen: async () => nativeOnly('Capturing a Pal virtual computer screen'),

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
			palId: project(id).palId,
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
	readyConversation: async (projectId, id) => {
		project(projectId)
		if (conversation(id).projectId !== projectId)
			throw new Error('This sample conversation belongs to another project.')
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
			publicPlugins: [
				{
					name: 'Sample research tools',
					version: '1.0.0',
					description: 'Find and review useful sources.',
				},
				{
					name: 'Sample writing tools',
					version: '1.0.0',
					description: 'Draft and refine your documents.',
				},
				{
					name: 'Sample planning tools',
					version: '1.0.0',
					description: 'Organize tasks and next steps.',
				},
			],
			publicNotice:
				'This design preview uses sample catalogue entries. Installing plugins is not connected.',
			plugins: [
				{
					name: 'Sample project tools',
					version: '1.0.0',
					description: 'Tools for your selected project.',
					scope: 'project',
					status: 'installed',
				},
				{
					name: 'Sample notes',
					version: '1.0.0',
					description: 'Notes available across your spaces.',
					scope: 'user',
					status: 'installed',
				},
				{
					name: 'Sample document tools',
					version: '1.0.0',
					description: 'Read and work with project documents.',
					scope: 'project',
					status: 'installed',
				},
			],
			live: false,
			canChange: false,
			notice:
				'No plugin runtime is connected in this design preview. The plugins below use sample data.',
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
	openExternal: async () => {},
	linkPreview: async (url) => {
		const page = new URL(url)
		if (page.pathname === '/plain') return null
		if (page.pathname === '/slow') await new Promise((resolve) => setTimeout(resolve, 1500))
		return {
			url,
			head: `<html><head><title>Fallback title</title>
<meta property="og:title" content="A calm way to read the web">
<meta property="og:description" content="Sample details for the link card: a short summary of the page, long enough to show how a few lines of description are clamped inside the card.">
<meta property="og:site_name" content="Example Journal">
<meta property="og:image" content="https://example.test/share.png">
<link rel="icon" sizes="32x32" href="/icon.png"></head>`,
		}
	},
	linkPreviewImage: async (_url, kind) => {
		const canvas = document.createElement('canvas')
		const [width, height] = kind === 'image' ? [1200, 630] : [32, 32]
		canvas.width = width
		canvas.height = height
		const context = canvas.getContext('2d')
		if (!context) return null
		const gradient = context.createLinearGradient(0, 0, width, height)
		gradient.addColorStop(0, kind === 'image' ? '#c7d2fe' : '#6366f1')
		gradient.addColorStop(1, kind === 'image' ? '#fbcfe8' : '#ec4899')
		context.fillStyle = gradient
		if (kind === 'icon') context.roundRect(0, 0, width, height, 8)
		else context.rect(0, 0, width, height)
		context.fill()
		return canvas.toDataURL('image/png')
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
