import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme } from 'electron'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'
import {
	readWindowMenu,
	readWindowMenuAnchor,
	windowCaptionColors,
	windowChrome,
	windowChromeOptions,
} from './window-chrome.js'

const here = dirname(fileURLToPath(import.meta.url))
const page = pathToFileURL(join(here, '../renderer/index.html')).href
let window: BrowserWindow | undefined
const cliEntry = process.env.NAMZU_DESKTOP_CLI
const command = cliEntry
	? {
			program: process.execPath,
			args: [cliEntry, 'acp', '--desktop'],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		}
	: process.platform === 'win32'
		? {
				program: process.env.ComSpec ?? 'cmd.exe',
				args: ['/d', '/s', '/c', 'namzu acp --desktop'],
			}
		: { program: 'namzu', args: ['acp', '--desktop'] }
const operator = new Operator(command, (event: DesktopEvent) => {
	if (window && !window.isDestroyed()) window.webContents.send('namzu:event', event)
})
function saveProjects(): void {
	const file = join(app.getPath('userData'), 'projects.json')
	writeFileSync(
		`${file}.tmp`,
		JSON.stringify(operator.listProjects().map((project) => project.path)),
		{ mode: 0o600 },
	)
	renameSync(`${file}.tmp`, file)
}
function register(): void {
	const handle = (name: string, action: (...args: never[]) => unknown) => {
		ipcMain.handle(`namzu:${name}`, (event, ...args) => {
			if (
				!window ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				event.senderFrame.url !== page
			)
				throw new Error('This window cannot control Namzu.')
			return action(...(args as never[]))
		})
	}
	handle('windowChrome', () => windowChrome(process.platform))
	handle('setWindowAppearance', (appearance: unknown) => {
		const colors = windowCaptionColors(appearance)
		if (!window || window.isDestroyed()) return
		nativeTheme.themeSource = appearance === 'light' ? 'light' : 'dark'
		if (process.platform === 'win32' || process.platform === 'linux')
			window.setTitleBarOverlay(colors)
	})
	handle('popupWindowMenu', (name: unknown, position: unknown) => {
		const menuName = readWindowMenu(name)
		if (!window || window.isDestroyed()) return
		const currentWindow = window
		const [width, height] = currentWindow.getContentSize()
		const anchor = readWindowMenuAnchor(position, {
			width,
			height,
			zoom: currentWindow.webContents.getZoomFactor(),
		})
		const menu = Menu.getApplicationMenu()?.getMenuItemById(menuName)?.submenu
		if (!menu) throw new Error('This window menu is unavailable.')
		return new Promise<void>((resolve) => {
			menu.popup({ window: currentWindow, ...anchor, callback: resolve })
		})
	})
	handle('projects', () => operator.listProjects())
	handle('openProject', async () => {
		if (!window) return null
		const picked = await dialog.showOpenDialog(window, {
			title: 'Open a project',
			properties: ['openDirectory'],
		})
		if (picked.canceled || !picked.filePaths[0]) return null
		const project = await operator.openProject(picked.filePaths[0])
		saveProjects()
		return project
	})
	handle('reconnectProject', (id: string) => operator.reconnect(id))
	handle('trustProject', async (id: string) => {
		const project = operator.listProjects().find((item) => item.id === id)
		if (!project || !window) throw new Error('Unknown project.')
		const answer = await dialog.showMessageBox(window, {
			type: 'question',
			title: 'Trust this folder?',
			message: 'Allow Namzu to work in this folder?',
			detail: `${project.path}\n\nNamzu can read files and run project commands here. You will be asked before tools need approval.`,
			buttons: ['Cancel', 'Trust folder'],
			defaultId: 0,
			cancelId: 0,
		})
		if (answer.response !== 1) return project
		return await operator.trust(id)
	})
	handle('conversations', (id: string) => operator.listConversations(id))
	handle('newConversation', (id: string) => operator.newConversation(id))
	handle('openConversation', (project: string, id: string) =>
		operator.openConversation(project, id),
	)
	handle('providers', (id: string, sessionId?: string) => operator.providers(id, sessionId))
	handle('selectProvider', (id: string, provider: string, model?: string) =>
		operator.selectProvider(id, provider, model),
	)
	handle('send', (id: string, prompt: string) => operator.send(id, prompt))
	handle('draft', (id: string) => operator.draft(id))
	handle('saveDraft', (id: string, draft: string) => operator.saveDraft(id, draft))
	handle('cancel', (id: string) => operator.cancel(id))
	handle('takeQueued', (id: string, itemId?: string) => operator.takeQueued(id, itemId))
	handle('removeQueued', (id: string, itemId: string) => operator.removeQueued(id, itemId))
	handle('approve', (id: string, request: string, approved: boolean) =>
		operator.approve(id, request, approved),
	)
	handle('jobs', (id: string) => operator.jobs(id))
	handle('readJob', (id: string, job: string) => operator.readJob(id, job))
	handle('stopJob', (id: string, job: string) => operator.stopJob(id, job))
}
async function createWindow(): Promise<void> {
	window = new BrowserWindow({
		title: 'Namzu',
		width: 1180,
		height: 820,
		minWidth: 560,
		minHeight: 460,
		backgroundColor: '#121212',
		show: false,
		...windowChromeOptions(process.platform),
		webPreferences: {
			preload: join(here, '../preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	})
	// The inline menu shares the title bar; retain native menu accelerators without
	// adding the operating system's second menu row on Windows and Linux.
	if (process.platform !== 'darwin') window.setMenuBarVisibility(false)
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
	window.webContents.on('will-navigate', (event, url) => {
		if (url !== page) event.preventDefault()
	})
	window.webContents.on('will-attach-webview', (event) => event.preventDefault())
	window.once('ready-to-show', () => window?.show())
	window.on('closed', () => {
		window = undefined
	})
	await window.loadURL(page)
}
app.on('activate', () => {
	if (!window) void createWindow()
})
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})
let quitting = false
let stopped = false
app.on('before-quit', (event) => {
	if (stopped) return
	event.preventDefault()
	if (quitting) return
	quitting = true
	void operator.close().finally(() => {
		stopped = true
		app.quit()
	})
})
// Keep module loading independent of Electron's ready event.
void app
	.whenReady()
	.then(async () => {
		Menu.setApplicationMenu(
			Menu.buildFromTemplate([
				...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
				{ id: 'edit', role: 'editMenu' },
				{ id: 'view', role: 'viewMenu' },
				{ id: 'window', role: 'windowMenu' },
			]),
		)
		register()
		await createWindow()
		try {
			const paths = JSON.parse(
				readFileSync(join(app.getPath('userData'), 'projects.json'), 'utf8'),
			) as unknown
			if (Array.isArray(paths))
				for (const path of paths.slice(0, 20))
					if (typeof path === 'string' && !quitting) await operator.openProject(path)
		} catch {
			/* First launch has no project catalog. */
		}
	})
	.catch((error: unknown) => {
		dialog.showErrorBox(
			'Namzu could not start',
			error instanceof Error ? error.message : String(error),
		)
		app.quit()
	})
