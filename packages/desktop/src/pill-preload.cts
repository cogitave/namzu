import { contextBridge, ipcRenderer } from 'electron'

/** What the working pill's page may do: hear what to draw, and say what the person pressed. */
type PillAction =
	| { type: 'stop'; sessionId: string }
	| { type: 'answer'; requestId: string; choice: 'allow' | 'once' | 'deny' }

contextBridge.exposeInMainWorld('pill', {
	onView: (listener: (view: unknown) => void) => {
		ipcRenderer.on('pill:view', (_event, view: unknown) => listener(view))
	},
	onFlags: (listener: (flags: unknown) => void) => {
		ipcRenderer.on('pill:flags', (_event, flags: unknown) => listener(flags))
	},
	act: (action: PillAction) => {
		ipcRenderer.send('pill:action', action)
	},
})
