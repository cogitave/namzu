import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the chooser and the recorder pill may do: hear what to draw, and say what the person pressed.
 * Neither page can read anything else, and neither is given the pictures or the events.
 */
type ChooserAnswer =
	| { type: 'start'; displayId: string; voice: boolean; microphone: string }
	| { type: 'cancel' }
	| { type: 'open-settings' }
	| { type: 'continue' }
type PillAction =
	| { type: 'pause' }
	| { type: 'resume' }
	| { type: 'done' }
	| { type: 'discard' }
	| { type: 'reconnect' }

contextBridge.exposeInMainWorld('recording', {
	onTheme: (listener: (dark: boolean) => void) => {
		ipcRenderer.on('recording:theme', (_event, dark: unknown) => listener(dark === true))
	},
	onChooser: (listener: (init: unknown) => void) => {
		ipcRenderer.on('recording:chooser', (_event, init: unknown) => listener(init))
	},
	size: (height: number) => {
		ipcRenderer.send('recording:chooser-size', height)
	},
	answer: (answer: ChooserAnswer) => {
		ipcRenderer.send('recording:chooser-answer', answer)
	},
	onPill: (listener: (view: unknown) => void) => {
		ipcRenderer.on('recording:pill', (_event, view: unknown) => listener(view))
	},
	pill: (action: PillAction) => {
		ipcRenderer.send('recording:pill-action', action)
	},
})
