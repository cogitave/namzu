import { contextBridge, ipcRenderer } from 'electron'

/** The Quick Entry box may do two things: start a conversation with its line, or close. */
contextBridge.exposeInMainWorld('quickEntry', {
	submit: (text: string) =>
		ipcRenderer.send('namzu:quick-entry-submit', String(text).slice(0, 4000)),
	cancel: () => ipcRenderer.send('namzu:quick-entry-cancel'),
})
