import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'
import type { BrowserContextProvider } from '../../context-providers.js'
import type { PaneChannel, PaneEvent, PaneTabRef } from '../../pane-channel.js'
import { createPaneProvider } from '../../pane-provider.js'

/**
 * A {@link PaneChannel} over a real Chromium: one browser-level WebSocket,
 * one flat session per page, child sessions (iframes, workers) named by the
 * session id Chromium gives them. It stands where an app's per-tab debugger
 * stands, so the pane transport talks real protocol with none of the app.
 */
export interface ChromiumPane extends PaneChannel {
	/** A page the "app" opened on its own, as the pane does for a popup. */
	addTab(url?: string): Promise<PaneTabRef>
	/** Close a tab the way the person would. */
	removeTab(tabId: string): Promise<void>
	/** Every command sent, `tab method`, for assertions on what crossed. */
	readonly sent: string[]
	/** Stop the browser. */
	shutdown(): Promise<void>
}

export interface ChromiumPaneOptions {
	/** Pages open before the agent connects. Default 0. */
	readonly initialTabs?: number
	/** Whether the app lets the agent open tabs. Default true. */
	readonly allowOpenTab?: boolean
}

interface Pending {
	resolve(value: unknown): void
	reject(error: Error): void
}

/**
 * Playwright's headless builds use the headless shell, which has no sign-in
 * prompt of its own; the full browser in headless mode does, and answers a
 * page that asks for credentials differently. The shell is the same browser
 * the launched-profile tests run on, so use it when it is installed.
 */
function chromiumBinary(): { executable: string; args: string[] } {
	const full = chromium.executablePath()
	const root = dirname(dirname(dirname(full)))
	try {
		const shell = readdirSync(root).find((name) => name.startsWith('chromium_headless_shell-'))
		if (shell) {
			const executable = join(root, shell, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
			if (existsSync(executable)) return { executable, args: [] }
		}
	} catch {
		// No cache beside the full browser; use it.
	}
	return { executable: full, args: ['--headless=new'] }
}

export async function startChromiumPane(options: ChromiumPaneOptions = {}): Promise<ChromiumPane> {
	const userDataDir = mkdtempSync(join(tmpdir(), 'namzu-pane-chromium-'))
	const binary = chromiumBinary()
	const child: ChildProcess = spawn(
		binary.executable,
		[
			...binary.args,
			'--remote-debugging-port=0',
			`--user-data-dir=${userDataDir}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--no-sandbox',
			'about:blank',
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] },
	)
	const endpoint = await new Promise<string>((resolve, reject) => {
		let text = ''
		child.stderr?.on('data', (chunk: Buffer) => {
			text += chunk.toString()
			const found = /DevTools listening on (ws:\/\/\S+)/.exec(text)
			if (found?.[1]) resolve(found[1])
		})
		child.once('exit', () => reject(new Error(`Chromium exited early:\n${text}`)))
	})
	const socket = new WebSocket(endpoint)
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true })
		socket.addEventListener(
			'error',
			() => reject(new Error('could not open the DevTools socket')),
			{
				once: true,
			},
		)
	})

	let nextId = 0
	const pending = new Map<number, Pending>()
	const eventListeners = new Set<(event: PaneEvent) => void>()
	const addedListeners = new Set<(tab: PaneTabRef) => void>()
	const closedListeners = new Set<(tabId: string) => void>()
	const downloadListeners = new Set<(name: string) => void>()
	const sessionOfTab = new Map<string, string>() // tabId -> page session
	const tabOfSession = new Map<string, string>() // page or child session -> tabId
	const attaching = new Map<string, Promise<string>>()
	const sent: string[] = []

	const send = (method: string, params: object = {}, sessionId?: string): Promise<unknown> =>
		new Promise((resolve, reject) => {
			nextId += 1
			pending.set(nextId, { resolve, reject })
			socket.send(
				JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }),
			)
		})

	socket.addEventListener('message', (message) => {
		const data = JSON.parse(String(message.data)) as {
			id?: number
			method?: string
			params?: Record<string, unknown>
			sessionId?: string
			result?: unknown
			error?: { message: string }
		}
		if (data.id !== undefined) {
			const waiting = pending.get(data.id)
			pending.delete(data.id)
			if (data.error) waiting?.reject(new Error(data.error.message))
			else waiting?.resolve(data.result ?? {})
			return
		}
		if (data.method === undefined) return
		const params = data.params ?? {}
		if (data.sessionId === undefined) {
			const info = params.targetInfo as
				| { targetId: string; type: string; openerId?: string }
				| undefined
			if (data.method === 'Target.attachedToTarget' && info?.type === 'page') {
				// The browser holds every new page until someone says go. A page the app opened
				// itself is let go at once; a popup waits for the agent to be ready for it.
				const sessionId = String(params.sessionId)
				sessionOfTab.set(info.targetId, sessionId)
				tabOfSession.set(sessionId, info.targetId)
				if (params.waitingForDebugger === true) {
					if (info.openerId) {
						for (const listener of addedListeners) {
							listener({ tabId: info.targetId, paused: true })
						}
					} else {
						void send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined)
					}
				}
			}
			if (data.method === 'Browser.downloadWillBegin') {
				for (const listener of downloadListeners) {
					listener(String(params.suggestedFilename ?? 'a file'))
				}
			}
			if (data.method === 'Target.targetDestroyed') {
				const targetId = String(params.targetId)
				sessionOfTab.delete(targetId)
				for (const listener of closedListeners) listener(targetId)
			}
			return
		}
		const tabId = tabOfSession.get(data.sessionId)
		if (tabId === undefined) return
		if (data.method === 'Target.attachedToTarget') {
			tabOfSession.set(String(params.sessionId), tabId)
		}
		const isPage = sessionOfTab.get(tabId) === data.sessionId
		const event: PaneEvent = {
			tabId,
			method: data.method,
			params,
			...(isPage ? {} : { sessionId: data.sessionId }),
		}
		for (const listener of eventListeners) listener(event)
	})

	const attach = (tabId: string): Promise<string> => {
		const known = sessionOfTab.get(tabId)
		if (known) return Promise.resolve(known)
		let promise = attaching.get(tabId)
		if (!promise) {
			promise = (async () => {
				const { sessionId } = (await send('Target.attachToTarget', {
					targetId: tabId,
					flatten: true,
				})) as { sessionId: string }
				sessionOfTab.set(tabId, sessionId)
				tabOfSession.set(sessionId, tabId)
				return sessionId
			})().finally(() => attaching.delete(tabId))
			attaching.set(tabId, promise)
		}
		return promise
	}

	await send('Target.setDiscoverTargets', { discover: true })
	await send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true })
	await send('Target.setAutoAttach', {
		autoAttach: true,
		waitForDebuggerOnStart: true,
		flatten: true,
	})
	const open = async (url = 'about:blank'): Promise<PaneTabRef> => {
		const { targetId } = (await send('Target.createTarget', { url })) as { targetId: string }
		return { tabId: targetId }
	}
	// Chromium opens one about:blank page of its own; the tabs the test asked for replace it.
	const existing = (await send('Target.getTargets')) as {
		targetInfos: { targetId: string; type: string }[]
	}
	const wanted = options.initialTabs ?? 0
	const pages = existing.targetInfos.filter((t) => t.type === 'page')
	for (const [index, page] of pages.entries()) {
		if (index >= wanted) await send('Target.closeTarget', { targetId: page.targetId })
	}
	for (let i = pages.length; i < wanted; i += 1) await open()

	const channel: ChromiumPane = {
		sent,
		async listTabs() {
			const all = (await send('Target.getTargets')) as {
				targetInfos: { targetId: string; type: string }[]
			}
			return all.targetInfos.filter((t) => t.type === 'page').map((t) => ({ tabId: t.targetId }))
		},
		async cdp(tabId, method, params, sessionId) {
			sent.push(`${tabId.slice(0, 4)} ${method}`)
			const page = await attach(tabId)
			return send(method, params ?? {}, sessionId ?? page)
		},
		onEvent(listener) {
			eventListeners.add(listener)
			return () => eventListeners.delete(listener)
		},
		onTabAdded(listener) {
			addedListeners.add(listener)
			return () => addedListeners.delete(listener)
		},
		onTabClosed(listener) {
			closedListeners.add(listener)
			return () => closedListeners.delete(listener)
		},
		onDownloadRefused(listener) {
			downloadListeners.add(listener)
			return () => downloadListeners.delete(listener)
		},
		...(options.allowOpenTab === false ? {} : { openTab: (url?: string) => open(url) }),
		async closeTab(tabId) {
			await send('Target.closeTarget', { targetId: tabId })
		},
		async close() {
			// The tabs stay open: the person's.
		},
		addTab: (url) => open(url),
		async removeTab(tabId) {
			await send('Target.closeTarget', { targetId: tabId })
		},
		async shutdown() {
			socket.close()
			child.kill('SIGKILL')
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) resolve()
				else child.once('exit', () => resolve())
			})
			rmSync(userDataDir, { recursive: true, force: true })
		},
	}
	return channel
}

/**
 * A provider that starts its own Chromium pane on first use and stops it
 * when the host lets go, so a host test can run on the pane path by swapping
 * one option.
 */
export function chromiumPaneProvider(options: ChromiumPaneOptions = {}): BrowserContextProvider {
	return {
		id: 'pane',
		async open(services) {
			const pane = await startChromiumPane(options)
			try {
				const opened = await createPaneProvider(pane).open(services)
				const connection = opened.connection
				return {
					...opened,
					connection: {
						close: async () => {
							await connection?.close()
							await pane.shutdown()
						},
						detach: async () => {
							await connection?.detach()
							await pane.shutdown()
						},
					},
				}
			} catch (error) {
				await pane.shutdown()
				throw error
			}
		},
	}
}
