import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	net,
	BrowserWindow,
	Menu,
	app,
	clipboard,
	dialog,
	ipcMain,
	nativeTheme,
	screen,
	session,
	shell,
} from 'electron'
import electronUpdater from 'electron-updater'
import type {
	PalPermissionChange,
	PalSubscriptionCreate,
	PalSubscriptionDisable,
} from '../shared/pal-communication-protocol.js'
import type {
	AttachmentInput,
	DesktopEvent,
	DesktopSendOptions,
	DesktopUndoOptions,
	DraftSettings,
	PalChanges,
	PalComputerInput,
	PalInput,
	PermissionResponse,
	WorkspaceAction,
} from '../shared/protocol.js'
import {
	type WorkspaceWindowBounds,
	locateWorkspaceTab,
	workspaceGroups,
} from '../shared/workspace-layout.js'
import { bundledCliEntry } from './bundled-runtime.js'
import { ClipboardTextWriter } from './clipboard-text.js'
import { DesktopDiagnostics, observeDesktopIpc, observeRendererConsole } from './diagnostics.js'
import { externalSourceUrl } from './external-url.js'
import { FolderAccess } from './folder-access.js'
import { humanComputer } from './host-computer.js'
import { electronLinkPreviewNetwork } from './link-preview-electron.js'
import { createLinkPreviewService } from './link-preview.js'
import { LocalSpeechRouting } from './local-speech-routing.js'
import { LocalSpeechService } from './local-speech.js'
import { createNewProject } from './new-project.js'
import { OpenIn, systemOpenInHost } from './open-in.js'
import { Operator } from './operator.js'
import { PalStreamProxy } from './pal-stream-proxy.js'
import { projectDraftOwner } from './project-draft-owner.js'
import { selectRendererPage } from './renderer-page.js'
import { desktopRuntimeNodeArgs } from './runtime-node-args.js'
import { installStreamRendererPolicy, withStreamRendererPort } from './stream-renderer-policy.js'
import { UpdateController, bakedFeedDeclared, updateFeedFromEnv } from './updater.js'
import {
	readWindowMenu,
	readWindowMenuAnchor,
	windowCaptionColors,
	windowChrome,
	windowChromeOptions,
} from './window-chrome.js'
import {
	WorkspaceWindowRegistry,
	WorkspaceWindows,
	clampWorkspaceBounds,
} from './workspace-windows.js'

// One operator owns this profile's sessions and persistent view metadata.
// Additional native views are created only through the authenticated workspace API.
if (!app.requestSingleInstanceLock()) app.exit(0)

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
const windows = new WorkspaceWindowRegistry<BrowserWindow>()
const workspaceFile = join(app.getPath('userData'), 'workspace-layout.json')
const restoredWorkspace = (() => {
	try {
		return JSON.parse(readFileSync(workspaceFile, 'utf8')) as unknown
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
			diagnostics.record('project_restore_failed', { error })
		return undefined
	}
})()
let savedWorkspaceContent: string | undefined
const workspace = new WorkspaceWindows(
	restoredWorkspace,
	randomUUID,
	() => {
		const currentIds = new Set(workspace.snapshot().windows.map((item) => item.id))
		for (const [id, window] of windows.entries())
			if (!window.isDestroyed() && currentIds.has(id))
				try {
					window.webContents.send('namzu:event', {
						kind: 'workspace',
						view: workspace.view(id),
					})
				} catch (error) {
					diagnostics.record('renderer_failed', { error })
				}
	},
	(layout) => {
		// Transient transfer preparation changes only the in-memory revision. The saved
		// source membership stays intact until the destination has acknowledged readiness.
		const content = JSON.stringify({
			version: layout.version,
			windows: layout.windows,
		})
		if (content === savedWorkspaceContent) return
		writeFileSync(`${workspaceFile}.tmp`, JSON.stringify(layout), {
			mode: 0o600,
		})
		renameSync(`${workspaceFile}.tmp`, workspaceFile)
		savedWorkspaceContent = content
	},
)
const transferTimers = new Map<string, ReturnType<typeof setTimeout>>()
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()
const allowNativeClose = new Set<string>()
const localSpeech = new LocalSpeechService({
	directory: join(app.getPath('userData'), 'local-speech'),
	// Chromium uses the native trust store and proxy policy; never disable TLS verification.
	fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
})
const localSpeechRouting = new LocalSpeechRouting(localSpeech, {
	assertOwner: (windowId, sessionId) => {
		const window = windows.entries().find(([id]) => id === windowId)?.[1]
		if (!window || window.isDestroyed()) throw new Error('This speech window has closed.')
		workspace.assertWindowWritable(windowId)
		if (workspace.view(windowId).closingWindow) throw new Error('This speech window is closing.')
		if (sessionId !== undefined) workspace.assertOwner(windowId, sessionId)
	},
	deliver: (windowId, event) => {
		const window = windows.entries().find(([id]) => id === windowId)?.[1]
		if (window && !window.isDestroyed()) window.webContents.send('namzu:local-speech-event', event)
	},
})
let observedSpeechFailure: string | undefined
function observeSpeechFailure(message: string | undefined, operation: string): void {
	// Compare private fixed failure messages for deduplication; never write their text or audio.
	if (message && observedSpeechFailure !== message)
		diagnostics.record('local_speech_failed', { operation })
	observedSpeechFailure = message
}
localSpeech.subscribe((event) => {
	if (event.type === 'state') {
		observeSpeechFailure(
			event.state.error,
			event.state.installation === 'failed' ? 'localSpeechInstall' : 'localSpeechState',
		)
		for (const [, window] of windows.entries())
			if (!window.isDestroyed()) window.webContents.send('namzu:local-speech-event', event)
	} else {
		if (event.type === 'error') observeSpeechFailure(event.message, 'localSpeechSpeak')
		localSpeechRouting.event(event)
	}
})
function discardAbortedWindows(): void {
	const current = new Set(workspace.snapshot().windows.map((item) => item.id))
	for (const [id, window] of windows.entries())
		if (!current.has(id)) {
			localSpeechRouting.cancelWindow(id)
			windows.remove(id)
			if (!window.isDestroyed()) window.destroy()
		}
	for (const [id, timer] of transferTimers)
		if (!workspace.hasTransfer(id)) {
			clearTimeout(timer)
			transferTimers.delete(id)
		}
}
function watchTransfer(id: string): void {
	if (transferTimers.has(id)) return
	// This is a recovery deadline for an unresponsive renderer, not a test timing assertion.
	const timer = setTimeout(() => {
		transferTimers.delete(id)
		if (!workspace.hasTransfer(id)) return
		workspace.rollback(id)
		discardAbortedWindows()
		diagnostics.record('ipc_failed', {
			operation: 'workspaceAction',
			error: new Error('Workspace transfer was not acknowledged.'),
		})
	}, 30_000)
	timer.unref()
	transferTimers.set(id, timer)
}
app.on('second-instance', () => {
	const pending = new Set(workspace.pendingNativeWindows())
	const target = windows
		.entries()
		.find(([id, window]) => !pending.has(id) && !window.isDestroyed())?.[1]
	if (!target) return
	if (target.isMinimized()) target.restore()
	target.show()
	target.focus()
})
const cliEntry =
	process.env.NAMZU_DESKTOP_CLI ??
	bundledCliEntry({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
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
		if (event.kind === 'pal-deleted' || event.kind === 'conversation-removed') {
			try {
				workspace.retireTabs(event.kind === 'pal-deleted' ? event.sessionIds : [event.sessionId])
				discardAbortedWindows()
			} catch (error) {
				diagnostics.record('ipc_failed', {
					operation: 'workspaceAction',
					error,
				})
			}
		}
		windows.fanout(event, (error) => diagnostics.record('renderer_failed', { error }))
	},
	app.getPath('userData'),
	diagnostics,
	streamProxy,
	new OpenIn(
		systemOpenInHost({
			showItemInFolder: (path) => shell.showItemInFolder(path),
			openPath: (path) => shell.openPath(path),
		}),
	),
)
/** Documents as the platform names it; the home folder's Documents when the platform has none. */
function documentsFolder(): string {
	try {
		return app.getPath('documents')
	} catch {
		return join(app.getPath('home'), 'Documents')
	}
}
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
	const clipboardWriter = new ClipboardTextWriter((text) => clipboard.writeText(text))
	// In-memory partition (no `persist:`): isolated from the app's cookies and cache.
	const linkPreview = createLinkPreviewService({
		network: electronLinkPreviewNetwork(session.fromPartition('namzu-link-preview')),
	})
	const conversationReads = new Map<
		string,
		{ projectId: string; promise: ReturnType<Operator['openConversation']> }
	>()
	type WindowContext = { id: string; window: BrowserWindow }
	const readOwners = new Map<string, number>([
		['palCommunication', 0],
		['draft', 0],
		['draftSettings', 0],
		['attachments', 0],
		['jobs', 0],
		['readJob', 0],
		['harnesses', 1],
		['providers', 1],
		['readyConversation', 1],
		['conversationMarkdown', 0],
		['undoStatus', 0],
		['undoPreview', 0],
		['models', 2],
		['modelSettings', 3],
		['plugins', 1],
	])
	const writeOwners = new Map<string, number>([
		['updatePalPermission', 0],
		['createPalSubscription', 0],
		['disablePalSubscription', 0],
		['selectHarness', 0],
		['selectProvider', 0],
		['setPluginEnabled', 0],
		['pickAttachments', 0],
		['addAttachments', 0],
		['removeAttachment', 0],
		['moveAttachments', 0],
		['send', 0],
		['sendCurrent', 0],
		['retryTurn', 0],
		['undoTurn', 0],
		['saveDraft', 0],
		['saveDraftSettings', 0],
		['cancel', 0],
		['takeQueued', 0],
		['removeQueued', 0],
		['respondPermission', 0],
		['stopJob', 0],
		['renameConversation', 0],
		['setConversationPinned', 0],
		['forkConversation', 0],
	])
	const catalogueActions = new Set([
		'renameConversation',
		'setConversationPinned',
		'forkConversation',
		'conversationMarkdown',
	])
	const globalWrites = new Set([
		'localSpeechConfigure',
		'localSpeechInstall',
		'createPal',
		'updatePal',
		'deletePal',
		'removeConversation',
		'startPalComputer',
		'stopPalComputer',
		'rebootPalComputer',
		'takeOverPalComputer',
		'returnPalComputerControl',
		'palComputerInput',
		'openProject',
		'openChat',
		'createProject',
		'trustFolder',
		'reconnectProject',
		'trustProject',
		'newConversation',
		'forkConversation',
		'restoreConversation',
	])
	const registerHandler = (
		name: string,
		action: (context: WindowContext, args: unknown[]) => unknown,
	) => {
		ipcMain.handle(`namzu:${name}`, (event, ...args) =>
			observeDesktopIpc(
				diagnostics,
				name,
				() => {
					const context = windows.authenticate(event, page)
					const writeIndex = writeOwners.get(name)
					if (writeIndex !== undefined || globalWrites.has(name))
						workspace.assertWindowWritable(context.id)
					if (globalWrites.has(name) && workspace.view(context.id).closingWindow)
						throw new Error('This window is preparing to close.')
					const readIndex = readOwners.get(name)
					const owner = args[writeIndex ?? readIndex ?? -1]
					const projectOwner = projectDraftOwner(owner)
					if (projectOwner?.workspace) {
						if (projectOwner.workspace.windowId !== context.id)
							throw new Error('This draft belongs to another window.')
						workspace.assertProjectDraft(
							context.id,
							projectOwner.workspace.groupId,
							writeIndex !== undefined,
						)
					}
					// A sidebar row has no tab anywhere. Only a tab in another window makes these
					// actions that window's to take; the operator adopts a tab-less conversation.
					const catalogueOnly =
						catalogueActions.has(name) &&
						typeof owner === 'string' &&
						!locateWorkspaceTab(workspace.snapshot(), owner)
					if (
						owner !== undefined &&
						!catalogueOnly &&
						!(typeof owner === 'string' && owner.startsWith('project:'))
					) {
						if (writeIndex !== undefined) workspace.assertOwner(context.id, owner)
						else if (readIndex !== undefined) workspace.assertReadable(context.id, owner)
					}
					if (name === 'moveAttachments') workspace.assertOwner(context.id, args[1])
					return action(context, args)
				},
				++sequence,
			),
		)
	}
	const handle = (name: string, action: (...args: never[]) => unknown) =>
		registerHandler(name, (_context, args) => action(...(args as never[])))
	const handleWindow = (
		name: string,
		action: (context: WindowContext, ...args: never[]) => unknown,
	) => registerHandler(name, (context, args) => action(context, ...(args as never[])))
	handleWindow('workspace', ({ id }) => workspace.view(id))
	handleWindow('workspaceReady', ({ id }, transferId: string) => {
		const view = workspace.ready(id, transferId)
		discardAbortedWindows()
		return view
	})
	handleWindow('workspaceCloseReady', ({ id, window }, closeId: string) => {
		workspace.assertCloseReady(id, closeId)
		const timer = closeTimers.get(id)
		if (timer) clearTimeout(timer)
		closeTimers.delete(id)
		const pending = new Set(workspace.pendingNativeWindows())
		const target = windows
			.entries()
			.find(
				([otherId, candidate]) =>
					otherId !== id && !pending.has(otherId) && !candidate.isDestroyed(),
			)
		if (target || process.platform === 'darwin') {
			workspace.closeWindow(id, target?.[0])
			windows.remove(id)
			discardAbortedWindows()
			allowNativeClose.add(id)
			window.close()
		} else app.quit()
	})
	handleWindow('workspaceAction', async ({ id, window }, action: WorkspaceAction) => {
		if (!action || typeof action !== 'object') throw new Error('Invalid workspace action.')
		if (action.kind === 'detach') {
			const bounds = clampWorkspaceBounds(
				action.bounds ?? {
					...window.getBounds(),
					x: window.getBounds().x + 40,
					y: window.getBounds().y + 40,
				},
				screen.getAllDisplays().map((display) => display.workArea),
			)
			const transfer = workspace.beginDetach(id, action.tabId, action.sourceGroupId, bounds)
			watchTransfer(transfer.id)
			try {
				await createWindow(transfer.destinationWindowId, bounds)
			} catch (error) {
				workspace.rollback(transfer.id)
				discardAbortedWindows()
				throw error
			}
			return workspace.view(id)
		}
		let size: { width: number; height: number } | undefined
		if (action.kind === 'move') {
			const target = windows.entries().find(([windowId]) => windowId === action.targetWindowId)?.[1]
			if (!target || target.isDestroyed()) throw new Error('The destination window is unavailable.')
			const [width, height] = target.getContentSize()
			size = { width, height: Math.max(1, height - 32) }
			if (action.size && Number.isFinite(action.size.width) && Number.isFinite(action.size.height))
				size = {
					width: Math.max(1, Math.min(width, action.size.width)),
					height: Math.max(1, Math.min(size.height, action.size.height)),
				}
		}
		const view = workspace.action(id, action, size)
		if (view.outgoingTransfer) watchTransfer(view.outgoingTransfer.id)
		if (view.pendingTransfer) watchTransfer(view.pendingTransfer.id)
		discardAbortedWindows()
		return view
	})
	handle('updateState', () => updates.state)
	handle('checkForUpdate', () => updates.check())
	handle('installUpdate', () => updates.install())
	handle('cancelUpdateInstall', () => updates.cancel())
	handleWindow('reportUiBusy', ({ id }, busy: unknown) => updates.report(id, busy))
	handle('diagnostics', () => diagnostics.view())
	handle('openExternal', (url: unknown) => shell.openExternal(externalSourceUrl(url)))
	// registerHandler authenticates the exact owned main frame before this
	// narrow write-only capability; no browser permission or read API is added.
	handle('copyText', (text: unknown) => clipboardWriter.copy(text))
	// Both resolve null for every refusal or failure, so nothing reaches diagnostics.
	handle('linkPreview', (url: unknown) => linkPreview.page(url))
	handle('linkPreviewImage', (url: unknown, kind: unknown) => linkPreview.image(url, kind))
	handle('localSpeechState', async () => {
		const state = await localSpeech.state()
		observeSpeechFailure(state.error, 'localSpeechState')
		return state
	})
	handle('localSpeechConfigure', (settings: Parameters<LocalSpeechService['configure']>[0]) =>
		localSpeech.configure(settings),
	)
	handle('localSpeechInstall', () => localSpeech.install())
	registerHandler('localSpeechSpeak', ({ id }, args) => localSpeechRouting.speak(id, args[0]))
	registerHandler('localSpeechCancel', ({ id }, args) => localSpeechRouting.cancel(id, args[0]))
	registerHandler('localSpeechAcknowledge', ({ id }, args) =>
		localSpeechRouting.acknowledge(id, args[0], args[1]),
	)
	handleWindow('setComputerKeyboardCapture', ({ window }, enabled: boolean) => {
		if (typeof enabled !== 'boolean') throw new Error('Invalid computer keyboard focus.')
		window.webContents.setIgnoreMenuShortcuts(enabled)
	})
	ipcMain.on('namzu:rendererDiagnostic', (event, report: unknown) => {
		try {
			windows.authenticate(event, page)
		} catch {
			return
		}
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
	handleWindow('setWindowAppearance', ({ window }, appearance: unknown) => {
		const colors = windowCaptionColors(appearance)
		if (window.isDestroyed()) return
		nativeTheme.themeSource = appearance === 'light' ? 'light' : 'dark'
		if (process.platform === 'win32' || process.platform === 'linux')
			window.setTitleBarOverlay(colors)
	})
	handleWindow('popupWindowMenu', ({ window }, name: unknown, position: unknown) => {
		const menuName = readWindowMenu(name)
		if (window.isDestroyed()) return
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
	handle('palCommunication', (sessionId: string, palId: string) =>
		operator.palCommunication(sessionId, palId),
	)
	handle('updatePalPermission', (sessionId: string, palId: string, change: PalPermissionChange) =>
		operator.updatePalPermission(sessionId, palId, change),
	)
	handle(
		'createPalSubscription',
		(sessionId: string, palId: string, input: PalSubscriptionCreate) =>
			operator.createPalSubscription(sessionId, palId, input),
	)
	handle(
		'disablePalSubscription',
		(sessionId: string, palId: string, input: PalSubscriptionDisable) =>
			operator.disablePalSubscription(sessionId, palId, input),
	)
	handle('palProviders', () => operator.palProviders())
	handle('palModels', (provider: string) => operator.palModels(provider))
	handle('createPal', (input: PalInput) => operator.createPal(input))
	handle('updatePal', (id: string, revision: number, changes: Partial<PalChanges>) =>
		operator.updatePal(id, revision, changes),
	)
	handle('deletePal', (id: string, revision: number) => operator.deletePal(id, revision))
	handle('removeConversation', (id: string) => operator.removeConversation(id))
	handle('renameConversation', (id: string, title: string) =>
		operator.renameConversation(id, title),
	)
	handle('setConversationPinned', (id: string, pinned: boolean) =>
		operator.setConversationPinned(id, pinned),
	)
	handle('forkConversation', (id: string) => operator.forkConversation(id))
	handle('conversationMarkdown', (id: string) => operator.conversationMarkdown(id))
	handle('projectGit', (id: string) => operator.projectGit(id))
	handle('projectChanges', (id: string) => operator.projectChanges(id))
	handle('projectDiff', (id: string, path: string) => operator.projectDiff(id, path))
	handle('listProjectDirectory', (id: string, dir: string) =>
		operator.listProjectDirectory(id, dir),
	)
	handle('projectFileIndex', (id: string) => operator.projectFileIndex(id))
	handle('readProjectFile', (id: string, path: string) => operator.readProjectFile(id, path))
	handle('resolveProjectLinks', (id: string, refs: string[]) =>
		operator.resolveProjectLinks(id, refs),
	)
	handle(
		'openProjectPath',
		(id: string, path: string, target: 'editor' | 'file-manager' | 'terminal', line?: number) =>
			operator.openProjectPath(id, path, target, line),
	)
	handle('projectEditors', () => operator.projectEditors())
	handle('archivedConversations', (id: string) => operator.archivedConversations(id))
	handle('restoreConversation', (sessionId: string) => operator.restoreConversation(sessionId))
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
	const folderAccess = new FolderAccess({
		openProject: (path) => operator.openProject(path),
		findProject: (id) => operator.listProjects().find((item) => item.id === id),
		trust: (id) => operator.trust(id),
	})
	handleWindow('openProject', async ({ id: windowId, window }) => {
		if (!window) return null
		const picked = await dialog.showOpenDialog(window, {
			title: 'Open a project',
			properties: ['openDirectory'],
		})
		if (picked.canceled || !picked.filePaths[0]) return null
		// The native picker is the only consent a normal folder needs; main records it here.
		const project = await folderAccess.picked(windowId, picked.filePaths[0])
		saveProjects()
		return project
	})
	handle('createProject', async () => {
		const path = await createNewProject({ documents: documentsFolder() })
		const project = await folderAccess.created(path)
		saveProjects()
		return project
	})
	handleWindow('trustFolder', async ({ id: windowId }, token: string) => {
		const project = await folderAccess.admit(windowId, token)
		saveProjects()
		return project
	})
	handle('reconnectProject', (id: string) => operator.reconnect(id))
	handleWindow('trustProject', ({ id: windowId }, id: string, token?: string) =>
		folderAccess.confirm(windowId, id, token),
	)
	handle('conversations', (id: string) => operator.listConversations(id))
	handleWindow('newConversation', async ({ id: windowId }, id: string) => {
		const before = workspace.view(windowId)
		const groupId =
			before.layout.windows.find((item) => item.id === windowId)?.focusedGroupId ??
			before.homeGroupId
		const conversation = await operator.newConversation(id)
		workspace.open(windowId, conversation.id, groupId)
		return conversation
	})
	handle('harnesses', (id: string, sessionId?: string) => operator.harnesses(id, sessionId))
	handle(
		'selectHarness',
		(id: string, engine: import('../shared/protocol.js').HarnessView['selected']) =>
			operator.selectHarness(id, engine),
	)
	handleWindow('openConversation', async ({ id: windowId }, project: string, id: string) => {
		const before = workspace.view(windowId)
		const groupId =
			before.layout.windows.find((item) => item.id === windowId)?.focusedGroupId ??
			before.homeGroupId
		const existingOwner = locateWorkspaceTab(workspace.snapshot(), id)
		if (existingOwner) workspace.assertReadable(windowId, id)
		else workspace.open(windowId, id, groupId)
		try {
			let read = conversationReads.get(id)
			if (read && read.projectId !== project)
				throw new Error('This conversation belongs to another project.')
			if (!read) {
				const promise = operator.openConversation(project, id).finally(() => {
					if (conversationReads.get(id)?.promise === promise) conversationReads.delete(id)
				})
				read = { projectId: project, promise }
				conversationReads.set(id, read)
			}
			const result = await read.promise
			workspace.assertReadable(windowId, id)
			return result
		} catch (error) {
			if (!existingOwner) {
				workspace.abortTransfers(windowId)
				discardAbortedWindows()
				const current = locateWorkspaceTab(workspace.snapshot(), id)
				if (current?.windowId === windowId)
					workspace.action(windowId, {
						kind: 'close',
						tabId: id,
						groupId: current.groupId,
					})
			}
			throw error
		}
	})
	handleWindow('readyConversation', async ({ id: windowId }, project: string, id: string) => {
		await operator.readyConversation(project, id)
		workspace.assertReadable(windowId, id)
	})
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
	const choosingFiles = new Set<string>()
	handleWindow('pickAttachments', async ({ id: windowId, window }, owner: string) => {
		operator.attachments(owner)
		if (choosingFiles.has(windowId)) throw new Error('Finish choosing files before adding more.')
		choosingFiles.add(windowId)
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
			if (!owner.startsWith('project:')) workspace.assertOwner(windowId, owner)
			const projectOwner = projectDraftOwner(owner)
			if (projectOwner?.workspace)
				workspace.assertProjectDraft(windowId, projectOwner.workspace.groupId, true)
			return picked.canceled
				? operator.attachments(owner)
				: await operator.addChosenFiles(owner, picked.filePaths)
		} finally {
			choosingFiles.delete(windowId)
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
	handle('sendCurrent', (id: string, prompt: string, options?: DesktopSendOptions) =>
		operator.sendCurrent(id, prompt, options),
	)
	handle(
		'retryTurn',
		(
			id: string,
			turnId: string,
			checkpointId: string,
			options?: Omit<DesktopSendOptions, 'attachmentIds'>,
		) => operator.retryTurn(id, turnId, checkpointId, options),
	)
	handle('undoStatus', (id: string, turnIds?: string[]) => operator.undoStatus(id, turnIds))
	handle('undoPreview', (id: string, turnId: string, options?: { alsoUndoLater?: boolean }) =>
		operator.undoPreview(id, turnId, options),
	)
	handle(
		'undoTurn',
		(id: string, turnId: string, planToken: string, options?: DesktopUndoOptions) =>
			operator.undoTurn(id, turnId, planToken, options),
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
	handle('respondPermission', (id: string, request: string, response: PermissionResponse) =>
		operator.respondPermission(id, request, response),
	)
	handle('jobs', (id: string) => operator.jobs(id))
	handle('backgroundWorkStatuses', () => operator.backgroundWorkStatuses())
	handle('refreshTasks', (id: string) => operator.refreshTasks(id))
	handle('readJob', (id: string, job: string) => operator.readJob(id, job))
	handle('stopJob', (id: string, job: string) => operator.stopJob(id, job))
}
async function createWindow(
	windowId: string = randomUUID(),
	savedBounds?: WorkspaceWindowBounds,
): Promise<void> {
	const bounds = clampWorkspaceBounds(
		savedBounds,
		screen.getAllDisplays().map((display) => display.workArea),
	)
	workspace.addWindow(windowId, bounds)
	const window = new BrowserWindow({
		title: 'Namzu',
		...bounds,
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
	windows.register(windowId, window)
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
	const abortTransfers = () => {
		localSpeechRouting.cancelWindow(windowId)
		workspace.abortTransfers(windowId)
		discardAbortedWindows()
	}
	window.on('unresponsive', abortTransfers)
	window.webContents.on('render-process-gone', (_event, details) => {
		diagnostics.record('renderer_process_gone', {
			reason: 'process-ended',
			exitCode: details.exitCode,
		})
		abortTransfers()
	})
	window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
		if (isMainFrame) {
			diagnostics.record('renderer_load_failed', { exitCode: errorCode })
			abortTransfers()
		}
	})
	window.webContents.on('preload-error', (_event, _path, error) => {
		diagnostics.record('renderer_failed', { error })
		abortTransfers()
	})
	window.webContents.on('console-message', (details) =>
		observeRendererConsole(diagnostics, details),
	)
	window.webContents.on('did-start-loading', () => window.webContents.setIgnoreMenuShortcuts(false))
	window.webContents.on('did-start-navigation', (details) => {
		// A new document cannot acknowledge the old document's queued audio.
		if (details.isMainFrame && !details.isSameDocument) localSpeechRouting.cancelWindow(windowId)
	})
	window.once('ready-to-show', () => window.show())
	const saveBounds = () => {
		if (!window.isDestroyed() && !window.isMinimized() && !window.isMaximized())
			workspace.setBounds(windowId, window.getBounds())
	}
	window.on('resized', saveBounds)
	window.on('moved', saveBounds)
	window.on('close', (event) => {
		if (stopped || quitting || allowNativeClose.delete(windowId)) return
		event.preventDefault()
		saveBounds()
		if (workspace.pendingNativeWindows().includes(windowId)) {
			workspace.abortTransfers(windowId)
			discardAbortedWindows()
			return
		}
		workspace.beginClose(windowId)
		discardAbortedWindows()
		if (closeTimers.has(windowId)) return
		const timer = setTimeout(() => {
			closeTimers.delete(windowId)
			workspace.cancelClose(windowId)
			diagnostics.record('ipc_failed', {
				operation: 'workspaceCloseReady',
				error: new Error('Workspace close was not acknowledged.'),
			})
		}, 30_000)
		timer.unref()
		closeTimers.set(windowId, timer)
	})
	window.on('closed', () => {
		localSpeechRouting.cancelWindow(windowId)
		windows.remove(windowId)
		const timer = closeTimers.get(windowId)
		if (timer) clearTimeout(timer)
		closeTimers.delete(windowId)
	})
	try {
		await window.loadURL(page)
	} catch (error) {
		windows.remove(windowId)
		workspace.closeWindow(windowId, windows.entries()[0]?.[0])
		window.destroy()
		throw error
	}
}
app.on('activate', () => {
	if (!windows.entries().length) {
		const saved = workspace.snapshot().windows[0]
		void createWindow(saved?.id, saved?.bounds).catch((error) =>
			diagnostics.record('startup_failed', { error }),
		)
	}
})
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})
const updateFeed = updateFeedFromEnv(process.env, { packaged: app.isPackaged })
function bakedUpdateConfig(): string | undefined {
	try {
		return readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
	} catch {
		return undefined
	}
}
const updates = new UpdateController({
	updater: () => electronUpdater.autoUpdater,
	// Nothing is checked unless a feed was named (environment) or the build itself declares one.
	enabled: updateFeed !== undefined || (app.isPackaged && bakedFeedDeclared(bakedUpdateConfig())),
	feed: updateFeed,
	mainBlockers: () => {
		// A closed window can no longer be busy.
		updates.retainWindows(windows.entries().map(([id]) => id))
		return operator.updateBlockers()
	},
	shutdown,
	relaunch: () => {
		app.relaunch()
		app.exit(0)
	},
	broadcast: (state) => {
		for (const [, window] of windows.entries())
			if (!window.isDestroyed()) window.webContents.send('namzu:update-state', state)
	},
	record: (_event, details) =>
		diagnostics.record('update_failed', {
			severity: 'warn',
			// Which half failed: finding or fetching the update, or handing over to the installer.
			operation:
				details?.stage === 'shutdown' || details?.stage === 'install'
					? 'installUpdate'
					: 'checkForUpdate',
			error: details?.error,
		}),
})
let quitting = false
let stopped = false
let shutdownRun: Promise<void> | undefined
/** Our graceful stop, shared by every way out: a normal quit and an app update. */
function shutdown(): Promise<void> {
	if (stopped) return Promise.resolve()
	if (shutdownRun) return shutdownRun
	quitting = true
	shutdownRun = Promise.all([operator.close(), localSpeech.dispose()])
		.then(async () => {
			await streamProxy.shutdown()
			stopped = true
		})
		.catch((error: unknown) => {
			quitting = false
			throw error
		})
		.finally(() => {
			shutdownRun = undefined
		})
	return shutdownRun
}
app.on('before-quit', (event) => {
	if (stopped) return
	event.preventDefault()
	if (shutdownRun) return
	void shutdown()
		.then(() => app.quit())
		.catch((error: unknown) => {
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
		updates.start()
		const saved = workspace.snapshot().windows
		if (saved.length) {
			for (const layout of saved) await createWindow(layout.id, layout.bounds)
		} else await createWindow()
		const tabs = saved.flatMap((item) => workspaceGroups(item.root).flatMap((group) => group.tabs))
		let priorPaths: string[] = []
		try {
			const paths = JSON.parse(
				readFileSync(join(app.getPath('userData'), 'projects.json'), 'utf8'),
			) as unknown
			if (Array.isArray(paths))
				priorPaths = paths.slice(0, 20).filter((path): path is string => typeof path === 'string')
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
				diagnostics.record('project_restore_failed', { error })
		}
		const restorePaths = [...new Set([...operator.restoredProjectPaths(tabs), ...priorPaths])]
		void (async () => {
			for (const path of restorePaths) {
				if (quitting) return
				try {
					await operator.openProject(path)
				} catch (error) {
					diagnostics.record('project_restore_failed', { error })
				}
			}
		})()
	})
	.catch((error: unknown) => {
		diagnostics.record('startup_failed', { error })
		dialog.showErrorBox(
			'Namzu could not start',
			error instanceof Error ? error.message : String(error),
		)
		app.quit()
	})
