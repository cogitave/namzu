import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	net,
	BrowserWindow,
	Menu,
	app,
	dialog,
	ipcMain,
	nativeTheme,
	session,
	shell,
} from 'electron'
import type {
	AttachmentInput,
	DesktopEvent,
	DesktopSendOptions,
	DraftSettings,
	PalChanges,
	PalComputerInput,
	PalInput,
} from '../shared/protocol.js'
import { DesktopDiagnostics, observeDesktopIpc, observeRendererConsole } from './diagnostics.js'
import { humanComputer } from './host-computer.js'
import { Operator } from './operator.js'
import { PalStreamProxy } from './pal-stream-proxy.js'
import { selectRendererPage } from './renderer-page.js'
import { desktopRuntimeNodeArgs } from './runtime-node-args.js'
import { installStreamRendererPolicy, withStreamRendererPort } from './stream-renderer-policy.js'
import {
	readWindowMenu,
	readWindowMenuAnchor,
	windowCaptionColors,
	windowChrome,
	windowChromeOptions,
} from './window-chrome.js'

const here = dirname(fileURLToPath(import.meta.url))
const diagnostics = new DesktopDiagnostics(app.getPath('userData'))
diagnostics.record('started', {
	engine:
		process.env.NAMZU_PAL_COMPUTER_ENGINE === undefined
			? 'default-docker'
			: process.env.NAMZU_PAL_COMPUTER_ENGINE === 'podman'
				? 'podman'
				: process.env.NAMZU_PAL_COMPUTER_ENGINE === 'docker'
					? 'docker'
					: 'invalid',
	platform:
		process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
			? process.platform
			: 'other',
})
process.on('uncaughtExceptionMonitor', (error) => diagnostics.record('unhandled_error', { error }))
let page = (() => {
	try {
		return selectRendererPage({
			isPackaged: app.isPackaged,
			productionPage: pathToFileURL(join(here, '../renderer/index.html')).href,
			developmentUrl: process.env.NAMZU_DESKTOP_DEV_URL,
		})
	} catch (error) {
		diagnostics.record('startup_failed', { error })
		throw error
	}
})()
const streamProxy = new PalStreamProxy(() =>
	diagnostics.record('computer_stream_failed', { severity: 'error' }),
)
let window: BrowserWindow | undefined
const cliEntry = process.env.NAMZU_DESKTOP_CLI
const command = cliEntry
	? {
			program: process.execPath,
			args: desktopRuntimeNodeArgs(cliEntry),
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		}
	: process.platform === 'win32'
		? {
				program: process.env.ComSpec ?? 'cmd.exe',
				args: ['/d', '/s', '/c', 'namzu acp --desktop'],
			}
		: { program: 'namzu', args: ['acp', '--desktop'] }
const operator = new Operator(
	command,
	(event: DesktopEvent) => {
		if (window && !window.isDestroyed()) window.webContents.send('namzu:event', event)
	},
	app.getPath('userData'),
	diagnostics,
	streamProxy,
)
function saveProjects(): void {
	const file = join(app.getPath('userData'), 'projects.json')
	writeFileSync(
		`${file}.tmp`,
		JSON.stringify(
			operator
				.listProjects()
				.filter((project) => !project.palId)
				.map((project) => project.path),
		),
		{ mode: 0o600 },
	)
	renameSync(`${file}.tmp`, file)
}
function register(): void {
	let sequence = 0
	const handle = (name: string, action: (...args: never[]) => unknown) => {
		ipcMain.handle(`namzu:${name}`, (event, ...args) =>
			observeDesktopIpc(
				diagnostics,
				name,
				() => {
					if (
						!window ||
						event.sender !== window.webContents ||
						event.senderFrame !== window.webContents.mainFrame ||
						event.senderFrame.url !== page
					)
						throw new Error('This window cannot control Namzu.')
					return action(...(args as never[]))
				},
				++sequence,
			),
		)
	}
	handle('diagnostics', () => diagnostics.view())
	handle('setComputerKeyboardCapture', (enabled: boolean) => {
		if (typeof enabled !== 'boolean') throw new Error('Invalid computer keyboard focus.')
		window?.webContents.setIgnoreMenuShortcuts(enabled)
	})
	ipcMain.on('namzu:rendererDiagnostic', (event, report: unknown) => {
		if (
			!window ||
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			event.senderFrame.url !== page
		)
			return
		if (!report || typeof report !== 'object') return
		const value = report as {
			reason?: unknown
			line?: unknown
			column?: unknown
		}
		const reason =
			value.reason === 'type-error' ||
			value.reason === 'reference-error' ||
			value.reason === 'unhandled-rejection'
				? value.reason
				: undefined
		diagnostics.record('renderer_failed', {
			reason,
			line: typeof value.line === 'number' ? value.line : undefined,
			column: typeof value.column === 'number' ? value.column : undefined,
		})
	})
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
	handle('pals', () => operator.listPals())
	handle('palProviders', () => operator.palProviders())
	handle('palModels', (provider: string) => operator.palModels(provider))
	handle('createPal', (input: PalInput) => operator.createPal(input))
	handle('updatePal', (id: string, revision: number, changes: Partial<PalChanges>) =>
		operator.updatePal(id, revision, changes),
	)
	handle('openPal', (id: string) => operator.openPal(id))
	handle('palComputer', (id: string) => operator.palComputer(id))
	handle('startPalComputer', (id: string) => operator.startPalComputer(id))
	handle('stopPalComputer', (id: string) => operator.stopPalComputer(id))
	handle('rebootPalComputer', (id: string, generation: string) =>
		operator.rebootPalComputer(id, generation),
	)
	handle('palScreen', (id: string, generation?: string) => operator.palScreen(id, generation))
	handle('openPalComputerStream', (id: string, generation: string) =>
		operator.openPalComputerStream(id, generation),
	)
	handle('closePalComputerStream', (id: string) => operator.closePalComputerStream(id))
	handle('humanComputer', () => humanComputer())
	handle('takeOverPalComputer', (id: string, generation: string) =>
		operator.takeOverPalComputer(id, generation),
	)
	handle('returnPalComputerControl', (id: string, generation: string) =>
		operator.returnPalComputerControl(id, generation),
	)
	handle('palComputerInput', (id: string, generation: string, input: PalComputerInput) =>
		operator.palComputerInput(id, generation, input),
	)
	handle('openChat', async () => {
		const project = await operator.openChat()
		saveProjects()
		return project
	})
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
	handle('harnesses', (id: string, sessionId?: string) => operator.harnesses(id, sessionId))
	handle(
		'selectHarness',
		(id: string, engine: import('../shared/protocol.js').HarnessView['selected']) =>
			operator.selectHarness(id, engine),
	)
	handle('openConversation', (project: string, id: string) =>
		operator.openConversation(project, id),
	)
	handle('providers', (id: string, sessionId?: string) => operator.providers(id, sessionId))
	handle('models', (id: string, provider: string, sessionId?: string) =>
		operator.models(id, provider, sessionId),
	)
	handle('modelSettings', (id: string, provider: string, model: string, sessionId?: string) =>
		operator.modelSettings(id, provider, model, sessionId),
	)
	handle('plugins', (id: string, sessionId?: string) => operator.plugins(id, sessionId))
	handle('setPluginEnabled', (id: string, name: string, enabled: boolean) =>
		operator.setPluginEnabled(id, name, enabled),
	)
	handle('selectProvider', (id: string, provider: string, model?: string) =>
		operator.selectProvider(id, provider, model),
	)
	let choosingFiles = false
	handle('pickAttachments', async (owner: string) => {
		operator.attachments(owner)
		if (!window || choosingFiles) throw new Error('Finish choosing files before adding more.')
		choosingFiles = true
		try {
			const picked = await dialog.showOpenDialog(window, {
				title: 'Attach files',
				properties: ['openFile', 'multiSelections'],
				filters: [
					{
						name: 'Images and text',
						extensions: [
							'png',
							'jpg',
							'jpeg',
							'webp',
							'gif',
							'txt',
							'md',
							'json',
							'yaml',
							'yml',
							'toml',
							'csv',
							'ts',
							'tsx',
							'js',
							'jsx',
							'py',
							'rs',
							'css',
							'html',
							'log',
						],
					},
					{ name: 'All files', extensions: ['*'] },
				],
			})
			return picked.canceled
				? operator.attachments(owner)
				: await operator.addChosenFiles(owner, picked.filePaths)
		} finally {
			choosingFiles = false
		}
	})
	handle('addAttachments', (owner: string, files: AttachmentInput[]) =>
		operator.addAttachments(owner, files),
	)
	handle('attachments', (owner: string) => operator.attachments(owner))
	handle('removeAttachment', (owner: string, id: string) => operator.removeAttachment(owner, id))
	handle('moveAttachments', (owner: string, target: string) =>
		operator.moveAttachments(owner, target),
	)
	handle('send', (id: string, prompt: string, options?: DesktopSendOptions) =>
		operator.send(id, prompt, options),
	)
	handle('draft', (id: string) => operator.draft(id))
	handle('saveDraft', (id: string, draft: string) => operator.saveDraft(id, draft))
	handle('draftSettings', (owner: string) => operator.draftSettings(owner))
	handle('saveDraftSettings', (owner: string, value: DraftSettings) =>
		operator.saveDraftSettings(owner, value),
	)
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
	window.webContents.on('will-redirect', (event, url) => {
		if (url !== page) event.preventDefault()
	})
	window.webContents.on('will-attach-webview', (event) => event.preventDefault())
	window.webContents.on('render-process-gone', (_event, details) =>
		diagnostics.record('renderer_process_gone', {
			reason: 'process-ended',
			exitCode: details.exitCode,
		}),
	)
	window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
		if (isMainFrame) diagnostics.record('renderer_load_failed', { exitCode: errorCode })
	})
	window.webContents.on('preload-error', (_event, _path, error) =>
		diagnostics.record('renderer_failed', { error }),
	)
	window.webContents.on('console-message', (details) =>
		observeRendererConsole(diagnostics, details),
	)
	window.webContents.on('did-start-loading', () =>
		window?.webContents.setIgnoreMenuShortcuts(false),
	)
	window.once('ready-to-show', () => window?.show())
	window.on('close', (event) => {
		if (process.platform === 'darwin' || stopped) return
		event.preventDefault()
		app.quit()
	})
	window.on('closed', () => {
		window = undefined
	})
	await window.loadURL(page)
}
app.on('activate', () => {
	if (!window) void createWindow().catch((error) => diagnostics.record('startup_failed', { error }))
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
	void operator
		.close()
		.then(async () => {
			await streamProxy.shutdown()
			stopped = true
			app.quit()
		})
		.catch((error: unknown) => {
			quitting = false
			diagnostics.record('shutdown_failed', { error })
			dialog.showErrorBox(
				'Namzu could not stop',
				error instanceof Error ? error.message : String(error),
			)
		})
})
// Keep module loading independent of Electron's ready event.
void app
	.whenReady()
	.then(async () => {
		const streamPort = await streamProxy.start()
		page = withStreamRendererPort(page, streamPort)
		streamProxy.allowRenderer(page)
		installStreamRendererPolicy({
			protocol: session.defaultSession.protocol,
			fetch: (request, options) => net.fetch(request, options),
			productionPage: pathToFileURL(join(here, '../renderer/index.html')).href,
			port: streamPort,
		})
		Menu.setApplicationMenu(
			Menu.buildFromTemplate([
				...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
				{ id: 'edit', role: 'editMenu' },
				{ id: 'view', role: 'viewMenu' },
				{ id: 'window', role: 'windowMenu' },
				{
					label: 'Help',
					submenu: [
						{
							label: 'Open diagnostic logs',
							accelerator: 'CmdOrCtrl+Shift+L',
							click: () => {
								void observeDesktopIpc(
									diagnostics,
									'openLogs',
									async () => {
										const error = await shell.openPath(diagnostics.directory)
										if (error) throw new Error('Diagnostic storage is unavailable.')
									},
									0,
								).catch(() =>
									dialog.showErrorBox(
										'Diagnostic logs unavailable',
										diagnostics.view().notice ?? 'Could not open the diagnostic folder.',
									),
								)
							},
						},
					],
				},
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
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
				diagnostics.record('project_restore_failed', { error })
		}
	})
	.catch((error: unknown) => {
		diagnostics.record('startup_failed', { error })
		dialog.showErrorBox(
			'Namzu could not start',
			error instanceof Error ? error.message : String(error),
		)
		app.quit()
	})
