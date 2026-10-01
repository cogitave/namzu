import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, DesktopEvent } from './shared/protocol.js'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`namzu:${name}`, ...args)
const api: DesktopApi = {
	windowChrome: () => invoke('windowChrome'),
	setWindowAppearance: (appearance) => invoke('setWindowAppearance', appearance),
	popupWindowMenu: (menu, anchor) => invoke('popupWindowMenu', menu, anchor),
	projects: () => invoke('projects'),
	openProject: () => invoke('openProject'),
	reconnectProject: (id) => ipcRenderer.invoke('namzu:reconnectProject', id),
	trustProject: (id) => invoke('trustProject', id),
	conversations: (id) => invoke('conversations', id),
	newConversation: (id) => invoke('newConversation', id),
	openConversation: (project, id) => invoke('openConversation', project, id),
	providers: (id, sessionId) => invoke('providers', id, sessionId),
	selectProvider: (id, provider, model) => invoke('selectProvider', id, provider, model),
	send: (id, prompt) => invoke('send', id, prompt),
	draft: (id) => invoke('draft', id),
	saveDraft: (id, draft) => invoke('saveDraft', id, draft),
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
