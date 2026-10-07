/// <reference types="vite/client" />

import { copyTextPayload } from '../shared/clipboard-text.js'
import { type HistoryWorkSnapshot, restoreHistoryWork } from '../shared/history-work.js'
import { emptyThread } from '../shared/projection.js'
import type {
	ChatMessage,
	ComposerModelSettings,
	ConversationView,
	DesktopApi,
	DesktopEvent,
	DraftSettings,
	HarnessView,
	ModelCatalogueView,
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
	workspaceGroups,
} from '../shared/workspace-layout.js'
import { sampleWorkingDiff, sampleWorkingTree } from './preview-changes.js'
import {
	listSampleDirectory,
	readSampleFile,
	resolveSampleLinks,
	sampleFileIndex,
} from './preview-files.js'

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
// Archived conversations are kept apart; restoring one moves it back into the catalogue.
const archived: ConversationView[] = [
	{
		id: 'sample-archived-1',
		projectId: 'sample-app',
		title: 'Sketch the onboarding flow',
		updatedAt: '2026-09-18T12:00:00.000Z',
	},
	{
		id: 'sample-archived-2',
		projectId: 'sample-app',
		title: 'Audit colour contrast',
		updatedAt: '2026-09-30T08:30:00.000Z',
	},
]
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
// The first sample conversation carries attachments, saved file edits and a pinned-looking history,
// so the details popover has sources, line totals and a diff drawer to show. Its three saved turns
// edited one file, three files, and nothing; they sit on two days with a long gap on the second.
const at = (day: number, hour: number, minute: number) => ({
	at: new Date(2026, 9, day, hour, minute).getTime(),
	source: 'journal' as const,
})
const thumbnail = (from: string, to: string) =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><rect x="40" y="48" width="120" height="204" rx="10" fill="rgba(255,255,255,.35)"/><rect x="184" y="48" width="176" height="28" rx="8" fill="rgba(255,255,255,.55)"/></svg>`,
	)}`
const sampleThread1 = messages.get('sample-thread-1')
if (sampleThread1)
	sampleThread1.splice(
		0,
		1,
		{
			role: 'user',
			text: 'Let’s work on refining the navigation. Here are my notes and mockups.',
			time: at(5, 10, 6),
			attachments: [
				{
					id: 'att-1',
					name: 'navigation-notes.md',
					kind: 'text',
					size: 2400,
					mediaType: 'text/markdown',
				},
				{
					id: 'att-2',
					name: 'sidebar-mockup.png',
					kind: 'image',
					size: 91000,
					mediaType: 'image/png',
					preview: thumbnail('#6366f1', '#06b6d4'),
				},
				{
					id: 'att-3',
					name: 'tokens.json',
					kind: 'text',
					size: 1200,
					mediaType: 'application/json',
				},
				{
					id: 'att-4',
					name: 'header-reference.png',
					kind: 'image',
					size: 64000,
					mediaType: 'image/png',
				},
			],
		},
		{ role: 'assistant', text: 'Reading the notes.', phase: 'commentary' },
		{
			role: 'user',
			text: 'Then apply the spacing changes.',
			time: at(5, 10, 8),
		},
	)
// The original sample answer stays where it was, as the end of the first turn.
const firstAnswer = sampleThread1?.at(-1)
if (firstAnswer) firstAnswer.time = at(5, 10, 12)
if (sampleThread1)
	sampleThread1.push(
		{
			role: 'user',
			text: 'Add focus and hover states across the rail, the tokens and the header.',
			time: at(6, 9, 30),
		},
		{
			role: 'assistant',
			text: 'Done. The rail, the token file and the header now share one focus ring and hover tint.\n\nThe rules are written up in [the design system](docs/2026-07-28-design-system.md). The rail styles are in `src/rail.css:3`, the header is `src/components/header.tsx`, and `docs/not-written-yet.md` does not exist, so it stays plain text.',
			time: at(6, 9, 41),
		},
		{
			role: 'user',
			text: 'Here is the new header mockup.',
			time: at(6, 17, 20),
			attachments: [
				{
					id: 'att-5',
					name: 'header-v2.png',
					kind: 'image',
					size: 52000,
					mediaType: 'image/png',
					preview: thumbnail('#f59e0b', '#ef4444'),
				},
			],
		},
		{
			role: 'assistant',
			text: 'Thanks. I will compare it with the rail next.',
			time: at(6, 17, 21),
		},
		{
			role: 'user',
			text: '',
			status: 'pending',
			attachments: [
				{
					id: 'att-6',
					name: 'footer-mockup.png',
					kind: 'image',
					size: 48000,
					mediaType: 'image/png',
				},
			],
		},
	)
const diff = (path: string, before: string, after: string) => ({
	kind: 'diff' as const,
	path,
	before,
	after,
})
const sampleWork: HistoryWorkSnapshot = {
	v: 1,
	partial: false,
	messages: [
		{ index: 0, messageId: 'u1', turnId: 't1', order: 2 },
		{ index: 1, messageId: 'a0', turnId: 't1', order: 3 },
		{ index: 2, messageId: 'u2', turnId: 't1', order: 4 },
		{ index: 3, messageId: 'a1', turnId: 't1', order: 7 },
		{ index: 4, messageId: 'u3', turnId: 't2', order: 12 },
		{ index: 5, messageId: 'a2', turnId: 't2', order: 17 },
		{ index: 6, messageId: 'u4', turnId: 't3', order: 22 },
		{ index: 7, messageId: 'a3', turnId: 't3', order: 23 },
	],
	turns: [
		{
			turnId: 't1',
			userMessageId: 'u1',
			order: 1,
			status: 'completed',
			reason: 'end_turn',
			durationMs: 257000,
		},
		{
			turnId: 't2',
			userMessageId: 'u3',
			order: 11,
			status: 'completed',
			reason: 'end_turn',
			durationMs: 83000,
		},
		{
			turnId: 't3',
			userMessageId: 'u4',
			order: 21,
			status: 'completed',
			reason: 'end_turn',
		},
	],
	tools: [
		{
			turnId: 't1',
			toolUseId: 'edit1',
			name: 'write',
			order: 5,
			status: 'completed',
			presentation: diff(
				'src/sidebar.css',
				'.row {\n  padding: 4px;\n  gap: 4px;\n}\n',
				'.row {\n  padding: 6px;\n  gap: 6px;\n  border-radius: 8px;\n}\n',
			),
		},
		{
			turnId: 't1',
			toolUseId: 'edit2',
			name: 'write',
			order: 6,
			status: 'completed',
			presentation: diff(
				'src/sidebar.css',
				'.row {\n  padding: 6px;\n  gap: 6px;\n  border-radius: 8px;\n}\n',
				'.row {\n  padding: 6px;\n  gap: 6px;\n  border-radius: 8px;\n}\n.row:hover {\n  background: var(--accent);\n}\n',
			),
		},
		{
			turnId: 't2',
			toolUseId: 'edit3',
			name: 'write',
			order: 13,
			status: 'completed',
			presentation: diff(
				'src/rail.css',
				'.rail a {\n  color: inherit;\n}\n',
				'.rail a {\n  color: inherit;\n}\n.rail a:hover {\n  background: var(--accent);\n}\n.rail a:focus-visible {\n  outline: 2px solid var(--ring);\n}\n',
			),
		},
		{
			turnId: 't2',
			toolUseId: 'edit4',
			name: 'write',
			order: 14,
			status: 'completed',
			presentation: diff(
				'design/tokens.json',
				'{\n  "ring": "#6366f1"\n}\n',
				'{\n  "ring": "#6366f1",\n  "hover": "#f4f4f5"\n}\n',
			),
		},
		{
			turnId: 't2',
			toolUseId: 'edit5',
			name: 'write',
			order: 15,
			status: 'completed',
			presentation: diff(
				'src/components/header.tsx',
				'export const Header = () => <header />\n',
				'export const Header = () => (\n  <header className="focus-ring">\n    <nav />\n  </header>\n)\n',
			),
		},
	],
}
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

// Engines other than Namzu carry their own provider, catalogue and effort levels, as the real
// Codex and Claude Code engines do, so the model and effort menus can be tried against each.
const engines: HarnessView['engines'] = [
	{ id: 'namzu', label: 'Namzu', available: true },
	{ id: 'codex-cli', label: 'Codex', available: true },
	{ id: 'claude-code', label: 'Claude Code', available: true },
]
const engineProviders: Record<
	Exclude<HarnessView['selected'], 'namzu'>,
	{
		provider: ProviderView['available'][number]
		models: ModelCatalogueView['models']
	}
> = {
	'codex-cli': {
		provider: { id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-6.1-sol' },
		models: [
			{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', default: true },
			{ id: 'gpt-6-astra', label: 'GPT-6 Astra' },
			{ id: 'gpt-6-sol', label: 'GPT-6 Sol' },
			{ id: 'gpt-6-luna', label: 'GPT-6 Luna' },
			{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
			{ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
			{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
			{ id: 'gpt-5.5', label: 'GPT-5.5' },
		],
	},
	'claude-code': {
		provider: {
			id: 'claude-code',
			label: 'Claude Code',
			defaultModel: 'claude-sonnet-5-5',
		},
		models: [
			{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', default: true },
			{ id: 'claude-opus-5-5', label: 'Opus 5.5' },
			{ id: 'claude-haiku-5', label: 'Haiku 5' },
		],
	},
}
const engineEffort: Record<string, ComposerModelSettings> = {
	'gpt-6.1-sol': {
		effortLevels: ['low', 'medium', 'high', 'xhigh'],
		effortDefault: 'medium',
	},
	'gpt-6-astra': {
		effortLevels: ['low', 'medium', 'high'],
		effortDefault: 'medium',
	},
	'gpt-6-sol': {
		effortLevels: ['low', 'medium', 'high'],
		effortDefault: 'medium',
	},
	'gpt-6-luna': {
		effortLevels: ['low', 'medium', 'high'],
		effortDefault: 'low',
	},
	'gpt-5.6-sol': {
		effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
		effortDefault: 'medium',
	},
	'gpt-5.6-terra': {
		effortLevels: ['low', 'medium', 'high'],
		effortDefault: 'medium',
	},
	'gpt-5.6-luna': { effortLevels: ['low', 'medium'], effortDefault: 'low' },
	'gpt-5.5': {},
	'claude-sonnet-5-5': {
		effortLevels: ['low', 'medium', 'high'],
		effortDefault: 'medium',
	},
	'claude-opus-5-5': {
		effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
		effortDefault: 'high',
	},
	'claude-haiku-5': {},
}
const harnesses = new Map<string, HarnessView['selected']>()
function engineOf(sessionId?: string): HarnessView['selected'] {
	return (sessionId && harnesses.get(sessionId)) || 'namzu'
}

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

function announceUpdate(view: ConversationView): ConversationView {
	view.updatedAt = new Date().toISOString()
	const next = clone(view)
	for (const listener of listeners)
		listener({ kind: 'conversation-updated', sessionId: view.id, view: next })
	return next
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
		const saved = clone(messages.get(id) ?? [])
		return {
			messages: saved,
			partial: false,
			...(id === 'sample-thread-1'
				? { thread: restoreHistoryWork(emptyThread(), saved, sampleWork) }
				: {}),
		}
	},
	renameConversation: async (id, title) => {
		const view = conversation(id)
		const trimmed = title.trim()
		view.title = trimmed || titles[Number(id.replace(/\D/g, '')) - 1]?.[1] || 'Sample conversation'
		return announceUpdate(view)
	},
	setConversationPinned: async (id, pinned) => {
		const view = conversation(id)
		if (pinned) view.pinned = true
		else view.pinned = undefined
		return announceUpdate(view)
	},
	forkConversation: async (id) => {
		const source = conversation(id)
		const saved = messages.get(id) ?? []
		if (saved.length === 0) throw new Error('There is nothing to fork yet.')
		const view: ConversationView = {
			id: `sample-thread-${nextConversation++}`,
			projectId: source.projectId,
			title: `${source.title} (fork)`,
			updatedAt: new Date().toISOString(),
		}
		conversations.unshift(view)
		messages.set(view.id, clone(saved))
		return clone(view)
	},
	conversationMarkdown: async (id) => {
		const title = conversation(id).title
		const body = (messages.get(id) ?? [])
			.map((message) => `**${message.role === 'user' ? 'You' : 'Namzu'}**\n\n${message.text}`)
			.join('\n\n')
		return { markdown: `# ${title}\n\n${body}\n`, truncated: false }
	},
	projectGit: async (projectId) => {
		const found = project(projectId)
		if (found.id === 'sample-app')
			return {
				branch: 'feat/navigation-polish',
				subject: 'Tighten the sidebar spacing and focus rings',
			}
		if (found.id === 'sample-docs') return { branch: null, subject: 'Rewrite the quick start' }
		return null
	},
	backgroundWorkStatuses: async () => ({
		'sample-thread-3': {
			state: 'known',
			runningCount: 2,
			// /preview?attention shows the warning-colour count on the Activity tab.
			needsAttention: new URLSearchParams(location.search).has('attention'),
			checkedAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
		},
	}),
	removeConversation: async (id) => {
		const view = conversation(id)
		conversations.splice(conversations.indexOf(view), 1)
		const event: DesktopEvent = {
			kind: 'conversation-removed',
			sessionId: id,
			projectId: view.projectId,
			archived: true,
		}
		// The real host also leaves every pane that showed it.
		for (const group of workspaceGroups(workspace.layout.windows[0]?.root ?? null))
			if (group.tabs.includes(id))
				commitLayout(
					closeWorkspaceTab(workspace.layout, {
						windowId,
						groupId: group.id,
						tabId: id,
					}),
				)
		archived.push(view)
		for (const listener of listeners) listener(event)
		return { sessionId: id, removed: true, archived: true }
	},
	listProjectDirectory: async (projectId, dir) => {
		project(projectId)
		return listSampleDirectory(projectId, dir)
	},
	projectFileIndex: async (projectId) => {
		project(projectId)
		return sampleFileIndex(projectId)
	},
	readProjectFile: async (projectId, path) => {
		project(projectId)
		return readSampleFile(projectId, path)
	},
	projectChanges: async (projectId) => {
		project(projectId)
		return sampleWorkingTree()
	},
	projectDiff: async (projectId, path) => {
		project(projectId)
		return sampleWorkingDiff(path)
	},
	resolveProjectLinks: async (projectId, refs) => {
		project(projectId)
		return resolveSampleLinks(projectId, refs)
	},
	openProjectPath: async () => nativeOnly('Opening a file in another program'),
	projectEditors: async () => [{ id: 'vscode', label: 'VS Code' }],
	archivedConversations: async (projectId) => {
		project(projectId)
		return clone(archived.filter((view) => view.projectId === projectId))
	},
	restoreConversation: async (id) => {
		const view = archived.find((item) => item.id === id)
		if (!view) throw new Error('That conversation is not archived.')
		archived.splice(archived.indexOf(view), 1)
		conversations.unshift(view)
		if (!messages.has(id))
			messages.set(id, [{ role: 'user', text: `Let’s pick up ${view.title.toLowerCase()}.` }])
		return announceUpdate(view)
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
		const engine = engineOf(id)
		if (engine !== 'namzu') {
			const { provider } = engineProviders[engine]
			return {
				available: [clone(provider)],
				selected: clone(
					(id && selections.get(id)) || {
						id: provider.id,
						model: provider.defaultModel,
					},
				),
			}
		}
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
	harnesses: async (projectId, id) => {
		project(projectId)
		return { selected: engineOf(id), locked: false, engines: clone(engines) }
	},
	selectHarness: async (id, engine) => {
		conversation(id)
		harnesses.set(id, engine)
		selections.delete(id)
		return { selected: engine, locked: false, engines: clone(engines) }
	},
	models: async (projectId, provider) => {
		project(projectId)
		for (const engine of Object.values(engineProviders))
			if (engine.provider.id === provider) return { models: clone(engine.models), notice: null }
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
	modelSettings: async (projectId, _provider, model) => {
		project(projectId)
		const engine = engineEffort[model]
		if (engine) return clone(engine)
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
		if (
			!available.some((item) => item.id === provider) &&
			!Object.values(engineProviders).some((engine) => engine.provider.id === provider)
		)
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
		if (id !== 'sample-thread-3') return []
		return [
			{
				id: 'job-1',
				command: 'pnpm dev',
				status: 'running',
				startedAt: Date.now() - 120_000,
			},
			{
				id: 'job-2',
				command: 'pnpm test --watch',
				status: 'running',
				startedAt: Date.now() - 60_000,
			},
		]
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
