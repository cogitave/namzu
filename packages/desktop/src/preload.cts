import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, DesktopEvent } from './shared/protocol.js'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`namzu:${name}`, ...args)
const api: DesktopApi = {
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
	openPal: (id) => invoke('openPal', id),
	palComputer: (id) => invoke('palComputer', id),
	startPalComputer: (id) => invoke('startPalComputer', id),
	stopPalComputer: (id) => invoke('stopPalComputer', id),
	palScreen: (id, generation) => invoke('palScreen', id, generation),
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
	openConversation: (project, id) => invoke('openConversation', project, id),
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
	draft: (id) => invoke('draft', id),
	saveDraft: (id, draft) => invoke('saveDraft', id, draft),
	draftSettings: (owner) => invoke('draftSettings', owner),
	saveDraftSettings: (owner, value) => invoke('saveDraftSettings', owner, value),
	cancel: (id) => invoke('cancel', id),
	takeQueued: (id, itemId) => invoke('takeQueued', id, itemId),
	removeQueued: (id, itemId) => invoke('removeQueued', id, itemId),
	approve: (id, request, approved) => invoke('approve', id, request, approved),
	jobs: (id) => invoke('jobs', id),
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
	ipcRenderer.send('namzu:rendererDiagnostic', { reason: 'unhandled-rejection' }),
)
