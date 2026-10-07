import { contextBridge, ipcRenderer } from 'electron'
import type { LocalSpeechEvent } from './shared/local-speech-protocol.js'
import type { DesktopApi, DesktopEvent } from './shared/protocol.js'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`namzu:${name}`, ...args)
const api: DesktopApi = {
	openExternal: (url) => invoke('openExternal', url),
	copyText: (text) => invoke('copyText', text),
	linkPreview: (url) => invoke('linkPreview', url),
	linkPreviewImage: (url, kind) => invoke('linkPreviewImage', url, kind),
	localSpeechState: () => invoke('localSpeechState'),
	localSpeechConfigure: (settings) => invoke('localSpeechConfigure', settings),
	localSpeechInstall: () => invoke('localSpeechInstall'),
	localSpeechSpeak: (input) => invoke('localSpeechSpeak', input),
	localSpeechCancel: (requestId) => invoke('localSpeechCancel', requestId),
	localSpeechAcknowledge: (requestId, sequence) =>
		invoke('localSpeechAcknowledge', requestId, sequence),
	onLocalSpeechEvent: (listener) => {
		const handler = (_event: unknown, data: LocalSpeechEvent) => listener(data)
		ipcRenderer.on('namzu:local-speech-event', handler)
		return () => ipcRenderer.removeListener('namzu:local-speech-event', handler)
	},
	workspace: () => invoke('workspace'),
	workspaceAction: (action) => invoke('workspaceAction', action),
	workspaceReady: (transferId) => invoke('workspaceReady', transferId),
	workspaceCloseReady: (closeId) => invoke('workspaceCloseReady', closeId),
	diagnostics: () => invoke('diagnostics'),
	windowChrome: () => invoke('windowChrome'),
	setComputerKeyboardCapture: (enabled) => invoke('setComputerKeyboardCapture', enabled),
	setWindowAppearance: (appearance) => invoke('setWindowAppearance', appearance),
	popupWindowMenu: (menu, anchor) => invoke('popupWindowMenu', menu, anchor),
	projects: () => invoke('projects'),
	pals: () => invoke('pals'),
	palProviders: () => invoke('palProviders'),
	palModels: (provider) => invoke('palModels', provider),
	createPal: (input) => invoke('createPal', input),
	updatePal: (id, revision, changes) => invoke('updatePal', id, revision, changes),
	deletePal: (id, revision) => invoke('deletePal', id, revision),
	palCommunication: (sessionId, palId) => invoke('palCommunication', sessionId, palId),
	updatePalPermission: (sessionId, palId, change) =>
		invoke('updatePalPermission', sessionId, palId, change),
	createPalSubscription: (sessionId, palId, input) =>
		invoke('createPalSubscription', sessionId, palId, input),
	disablePalSubscription: (sessionId, palId, input) =>
		invoke('disablePalSubscription', sessionId, palId, input),
	openPal: (id) => invoke('openPal', id),
	palComputer: (id) => invoke('palComputer', id),
	startPalComputer: (id) => invoke('startPalComputer', id),
	stopPalComputer: (id) => invoke('stopPalComputer', id),
	rebootPalComputer: (id, generation) => invoke('rebootPalComputer', id, generation),
	palScreen: (id, generation) => invoke('palScreen', id, generation),
	openPalComputerStream: (id, generation) => invoke('openPalComputerStream', id, generation),
	closePalComputerStream: (id) => invoke('closePalComputerStream', id),
	humanComputer: () => invoke('humanComputer'),
	takeOverPalComputer: (id, generation) => invoke('takeOverPalComputer', id, generation),
	returnPalComputerControl: (id, generation) => invoke('returnPalComputerControl', id, generation),
	palComputerInput: (id, generation, input) => invoke('palComputerInput', id, generation, input),
	openProject: () => invoke('openProject'),
	openChat: () => invoke('openChat'),
	reconnectProject: (id) => ipcRenderer.invoke('namzu:reconnectProject', id),
	trustProject: (id) => invoke('trustProject', id),
	conversations: (id) => invoke('conversations', id),
	newConversation: (id) => invoke('newConversation', id),
	harnesses: (id, sessionId) => invoke('harnesses', id, sessionId),
	selectHarness: (id, engine) => invoke('selectHarness', id, engine),
	openConversation: (project, id) => invoke('openConversation', project, id),
	readyConversation: (project, id) => invoke('readyConversation', project, id),
	removeConversation: (id) => invoke('removeConversation', id),
	renameConversation: (id, title) => invoke('renameConversation', id, title),
	setConversationPinned: (id, pinned) => invoke('setConversationPinned', id, pinned),
	forkConversation: (id) => invoke('forkConversation', id),
	conversationMarkdown: (id) => invoke('conversationMarkdown', id),
	projectGit: (id) => invoke('projectGit', id),
	projectChanges: (id) => invoke('projectChanges', id),
	projectDiff: (id, path) => invoke('projectDiff', id, path),
	listProjectDirectory: (id, dir) => invoke('listProjectDirectory', id, dir),
	projectFileIndex: (id) => invoke('projectFileIndex', id),
	readProjectFile: (id, path) => invoke('readProjectFile', id, path),
	resolveProjectLinks: (id, refs) => invoke('resolveProjectLinks', id, refs),
	openProjectPath: (id, path, target, line) => invoke('openProjectPath', id, path, target, line),
	projectEditors: () => invoke('projectEditors'),
	archivedConversations: (id) => invoke('archivedConversations', id),
	restoreConversation: (sessionId) => invoke('restoreConversation', sessionId),
	providers: (id, sessionId) => invoke('providers', id, sessionId),
	models: (id, provider, sessionId) => invoke('models', id, provider, sessionId),
	modelSettings: (id, provider, model, sessionId) =>
		invoke('modelSettings', id, provider, model, sessionId),
	plugins: (id, sessionId) => invoke('plugins', id, sessionId),
	setPluginEnabled: (id, name, enabled) => invoke('setPluginEnabled', id, name, enabled),
	selectProvider: (id, provider, model) => invoke('selectProvider', id, provider, model),
	pickAttachments: (owner) => invoke('pickAttachments', owner),
	addAttachments: (owner, files) => invoke('addAttachments', owner, files),
	attachments: (owner) => invoke('attachments', owner),
	removeAttachment: (owner, id) => invoke('removeAttachment', owner, id),
	moveAttachments: (owner, target) => invoke('moveAttachments', owner, target),
	send: (id, prompt, options) => invoke('send', id, prompt, options),
	sendCurrent: (id, prompt, options) => invoke('sendCurrent', id, prompt, options),
	retryTurn: (id, turnId, checkpointId, options) =>
		invoke('retryTurn', id, turnId, checkpointId, options),
	undoStatus: (id, turnIds) => invoke('undoStatus', id, turnIds),
	undoPreview: (id, turnId, options) => invoke('undoPreview', id, turnId, options),
	undoTurn: (id, turnId, planToken, options) => invoke('undoTurn', id, turnId, planToken, options),
	draft: (id) => invoke('draft', id),
	saveDraft: (id, draft) => invoke('saveDraft', id, draft),
	draftSettings: (owner) => invoke('draftSettings', owner),
	saveDraftSettings: (owner, value) => invoke('saveDraftSettings', owner, value),
	cancel: (id) => invoke('cancel', id),
	takeQueued: (id, itemId) => invoke('takeQueued', id, itemId),
	removeQueued: (id, itemId) => invoke('removeQueued', id, itemId),
	respondPermission: (id, request, response) => invoke('respondPermission', id, request, response),
	jobs: (id) => invoke('jobs', id),
	backgroundWorkStatuses: () => invoke('backgroundWorkStatuses'),
	refreshTasks: (id) => invoke('refreshTasks', id),
	readJob: (id, job) => invoke('readJob', id, job),
	stopJob: (id, job) => invoke('stopJob', id, job),
	onEvent: (listener) => {
		const handler = (_event: unknown, data: DesktopEvent) => listener(data)
		ipcRenderer.on('namzu:event', handler)
		return () => ipcRenderer.removeListener('namzu:event', handler)
	},
}
contextBridge.exposeInMainWorld('namzu', api)
// Report failures without transferring error text, stacks, URLs or page content.
window.addEventListener('error', (event) => {
	ipcRenderer.send('namzu:rendererDiagnostic', {
		reason:
			event.error instanceof TypeError
				? 'type-error'
				: event.error instanceof ReferenceError
					? 'reference-error'
					: undefined,
		line: event.lineno,
		column: event.colno,
	})
})
window.addEventListener('unhandledrejection', () =>
	ipcRenderer.send('namzu:rendererDiagnostic', {
		reason: 'unhandled-rejection',
	}),
)
