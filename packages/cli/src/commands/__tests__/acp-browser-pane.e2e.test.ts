import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MCPJsonRpcMessage, MCPTransport } from '@namzu/sdk'
import { ACPServer, HostCommandRegistry } from '@namzu/sdk'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createBrowserControl } from '../../browser/control.js'
import {
	BROWSER_PANE_CAPABILITY,
	BROWSER_PANE_METHODS,
	type PaneConnection,
	createAcpPaneLink,
} from '../acp-browser-pane.js'
import {
	type AcpRuntimeDependencies,
	type CliAcpRuntimeOptions,
	createCliAcpRuntime,
	handoffWindow,
} from '../acp.js'

/**
 * The engine's browser tool driving a tab it was handed by the app, over the same requests the
 * real app answers, with a real Chromium behind them. The app is a fake client that serves
 * `namzu/browser/pane/*` from a Chromium page channel (the helper `@namzu/browser`'s own pane tests
 * use); everything on the engine's side is the real code: the runtime's session options, the browser
 * control, the host, Playwright, and the pane transport. Nothing leaves 127.0.0.1.
 *
 * Opt in with NAMZU_BROWSER_E2E=1, like the browser package's end-to-end suites. Under an isolated
 * HOME set PLAYWRIGHT_BROWSERS_PATH to the directory that holds `chromium-*`.
 */
const E2E = process.env.NAMZU_BROWSER_E2E === '1'

const HELPERS = join(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'..',
	'browser',
	'src',
	'__tests__',
	'e2e',
)
// A path built at run time: the helpers belong to another package's tests and are not part of
// this package's build.
const load = async <T>(name: string): Promise<T> =>
	(await import(/* @vite-ignore */ pathToFileURL(join(HELPERS, name)).href)) as T

interface Chromium {
	startChromiumPane(options?: { initialTabs?: number }): Promise<ChromiumPane>
}
interface ChromiumPane {
	listTabs(): Promise<readonly { tabId: string }[]>
	cdp(tabId: string, method: string, params?: object, sessionId?: string): Promise<unknown>
	onEvent(
		listener: (event: {
			tabId: string
			method: string
			params?: unknown
			sessionId?: string
		}) => void,
	): () => void
	onTabAdded(listener: (tab: { tabId: string }) => void): () => void
	onTabClosed(listener: (tabId: string) => void): () => void
	shutdown(): Promise<void>
	readonly sent: string[]
}
interface Fixture {
	startFixtureServer(): Promise<{
		allowed: string
		other: string
		close(): Promise<void>
	}>
}

const DESKTOP = join(import.meta.dirname, '..', '..', '..', '..', 'desktop', 'src', 'main')
const loadDesktop = async <T>(name: string): Promise<T> =>
	(await import(/* @vite-ignore */ pathToFileURL(join(DESKTOP, name)).href)) as T

const SESSION = 'session-pane'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-pane-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

describe.skipIf(!E2E)(
	'the engine’s browser tool over the app’s Browser pane',
	{ timeout: 90_000 },
	() => {
		let server: Awaited<ReturnType<Fixture['startFixtureServer']>>
		let chromium: Chromium
		beforeAll(async () => {
			server = await (await load<Fixture>('fixture-server.ts')).startFixtureServer()
			chromium = await load<Chromium>('pane-chromium-channel.ts')
		})
		afterAll(async () => {
			await server?.close()
		})

		/** The app, as the engine sees it: it answers the three requests from a page channel. */
		function fakeApp(pane: ChromiumPane, offered: boolean) {
			const asked: { method: string; params: Record<string, unknown> }[] = []
			let primary: string | undefined
			const connection: PaneConnection = {
				offers: (capability) => offered && capability === BROWSER_PANE_CAPABILITY,
				ask: async (method, params) => {
					asked.push({ method, params })
					if (method === BROWSER_PANE_METHODS.open) {
						const [tab] = await pane.listTabs()
						if (!tab) throw new Error('There is no Browser pane to open a tab in.')
						primary = tab.tabId
						const info = (await pane.cdp(tab.tabId, 'Target.getTargetInfo')) as {
							targetInfo: unknown
						}
						return { tabId: tab.tabId, targetInfo: info.targetInfo }
					}
					if (method === BROWSER_PANE_METHODS.cdp) {
						const result = await pane.cdp(
							String(params.tabId),
							String(params.method),
							(params.params as object | undefined) ?? {},
							params.cdpSessionId as string | undefined,
						)
						return { result }
					}
					return {}
				},
			}
			const link = createAcpPaneLink(connection)
			const event = link.extensions[BROWSER_PANE_METHODS.event]
			pane.onEvent((e) =>
				event?.({
					sessionId: SESSION,
					kind: 'cdp',
					tabId: e.tabId,
					method: e.method,
					params: e.params,
					...(e.sessionId ? { cdpSessionId: e.sessionId } : {}),
				}),
			)
			pane.onTabAdded((tab) => event?.({ sessionId: SESSION, kind: 'tab-added', tabId: tab.tabId }))
			pane.onTabClosed((tabId) => event?.({ sessionId: SESSION, kind: 'tab-closed', tabId }))
			return { link, asked, primary: () => primary }
		}

		/** The runtime hands the session builder the browser options; the session built is the real control. */
		async function buildRuntime(
			runtimeOptions: CliAcpRuntimeOptions,
			browserConfig: Record<string, unknown>,
			use: (control: ReturnType<typeof createBrowserControl>) => Promise<void>,
		) {
			const { PlaywrightBrowserHost, createPaneProvider } = await import('@namzu/browser')
			let control: ReturnType<typeof createBrowserControl> | undefined
			const deps = {
				probe: async () => ({
					preferences: {
						version: 3,
						providers: [{ id: 'mock' }],
						subagents: { active: [] },
					},
					detected: [],
				}),
				decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
				resolveProjectContext: (value: unknown) => value,
				resolveSession: async (sessionId: string) => ({ sessionId }),
				createSession: async (_p: unknown, _d: unknown, options: Record<string, unknown>) => {
					const browser = options.browser as Parameters<typeof createBrowserControl>[1]
					control = createBrowserControl(PlaywrightBrowserHost, browser, (channel) =>
						createPaneProvider(channel),
					)
					const built = control
					return {
						hasProvider: true,
						errorHint: null,
						mcpFailed: [],
						browser: built,
						send: async function* () {
							await use(built)
							yield { kind: 'done', stopReason: 'end_turn' }
						},
						close: async () => {
							await built.dispose()
						},
						presenter: {
							presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
							presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
						},
						jobs: () => [],
					}
				},
			} as unknown as AcpRuntimeDependencies
			const runtime = createCliAcpRuntime(
				{
					config: { browser: browserConfig },
					formatter: { name: 'text', print() {}, info() {}, error() {} },
				} as never,
				deps,
				runtimeOptions,
			)
			return { runtime, control: () => control }
		}

		async function runBrowser(
			runtimeOptions: CliAcpRuntimeOptions,
			browserConfig: Record<string, unknown>,
			use: (control: ReturnType<typeof createBrowserControl>) => Promise<void>,
		): Promise<void> {
			const { runtime, control: current } = await buildRuntime(runtimeOptions, browserConfig, use)
			try {
				await runtime.gateway.prompt({
					sessionId: SESSION,
					cwd,
					prompt: 'open the page',
					history: [],
					signal: new AbortController().signal,
					onEvent() {},
					ask: async () => ({ kind: 'approve' }),
					filesystem: undefined,
				})
			} finally {
				await current()?.dispose()
				await runtime.close()
			}
		}

		it('navigates a local page in the app’s tab and reads it, sending the site rules once', async () => {
			const pane = await chromium.startChromiumPane({ initialTabs: 1 })
			const app = fakeApp(pane, true)
			let where: unknown
			try {
				await runBrowser(
					{ computerUse: true, browserPane: app.link },
					{
						sites: {
							[server.allowed]: 'act',
							'http://bank.example': 'deny',
							'*': 'ask',
						},
					},
					async (control) => {
						const opened = await control.host.observe({
							action: 'navigate',
							url: `${server.allowed}/index.html`,
						})
						expect(opened.page?.title).toBe('Fixture index')
						const snapshot = await control.host.observe({ action: 'snapshot' })
						expect(snapshot.snapshot?.text).toContain('Order form')
						where = control.status().where
						// The sign-in card's place is known once the browser runs: the app's pane.
						expect(handoffWindow(control.status())).toBe('pane')
					},
				)
			} finally {
				await pane.shutdown()
			}
			expect(where).toBe('pane')
			// One tab was asked for, with the rules; every page call went through the app.
			const opens = app.asked.filter((call) => call.method === BROWSER_PANE_METHODS.open)
			expect(opens).toHaveLength(1)
			expect(opens[0]?.params).toMatchObject({
				sessionId: SESSION,
				rules: { deny: ['bank.example'] },
			})
			expect(app.asked.some((call) => call.method === BROWSER_PANE_METHODS.cdp)).toBe(true)
			expect(pane.sent.some((entry) => entry.endsWith('Page.navigate'))).toBe(true)
			// And it let go when the session closed.
			expect(app.asked.at(-1)?.method).toBe(BROWSER_PANE_METHODS.close)
		})

		it('drives the app’s tab through the real ACP server and the app’s own request handler on one pipe', async () => {
			const { serveAgentPane } = await loadDesktop<{
				serveAgentPane: (
					relay: unknown,
					conversationId: string,
					method: string,
					params: unknown,
					allowed: () => boolean,
				) => Promise<
					| { ok: true; result: unknown }
					| { ok: false; code: number; message: string; reason?: string }
				>
			}>('agent-pane-acp.ts')
			const pane = await chromium.startChromiumPane({ initialTabs: 1 })
			const requests: string[] = []
			const released: string[] = []
			let closedTabs = 0
			const relay = {
				open: async () => {
					const [tab] = await pane.listTabs()
					if (!tab) throw new Error('There is no Browser pane to open a tab in.')
					const info = (await pane.cdp(tab.tabId, 'Target.getTargetInfo')) as {
						targetInfo: unknown
					}
					return { tabId: tab.tabId, targetInfo: info.targetInfo }
				},
				cdp: async (input: {
					tabId: string
					method: string
					params?: object
					sessionId?: string
				}) => pane.cdp(input.tabId, input.method, input.params ?? {}, input.sessionId),
				close: () => {
					closedTabs += 1
				},
				releaseConversation: (id: string) => {
					released.push(id)
				},
			}
			let receive!: (message: MCPJsonRpcMessage) => void
			let session = ''
			const answers = new Map<number | string, (message: MCPJsonRpcMessage) => void>()
			const transport: MCPTransport = {
				connect: async () => {},
				close: async () => {},
				isConnected: () => true,
				onMessage: (handler) => {
					receive = handler
				},
				onClose: () => {},
				onError: () => {},
				send: async (message) => {
					if (message.id !== undefined && message.method?.startsWith('namzu/browser/pane/')) {
						requests.push(message.method)
						const answer = await serveAgentPane(
							relay,
							'app-conversation',
							message.method,
							message.params,
							() => true,
						)
						receive(
							answer.ok
								? { jsonrpc: '2.0', id: message.id, result: answer.result as never }
								: {
										jsonrpc: '2.0',
										id: message.id,
										error: { code: answer.code, message: answer.message },
									},
						)
						return
					}
					if (message.id !== undefined && !message.method) answers.get(message.id)?.(message)
				},
			}
			const call = (id: number, method: string, params: Record<string, unknown>) =>
				new Promise<MCPJsonRpcMessage>((resolve) => {
					answers.set(id, resolve)
					receive({ jsonrpc: '2.0', id, method, params })
				})
			let title: string | undefined
			let acp: ACPServer | undefined
			try {
				const connection: PaneConnection = {
					offers: (capability) => acp?.clientOffers(capability) ?? false,
					ask: (method, params) => acp?.askClient(method, params) as Promise<unknown>,
				}
				const link = createAcpPaneLink(connection)
				const { runtime, control } = await buildRuntime(
					{ computerUse: true, browserPane: link },
					{ sites: { [server.allowed]: 'act', '*': 'ask' } },
					async (browser) => {
						const opened = await browser.host.observe({
							action: 'navigate',
							url: `${server.allowed}/index.html`,
						})
						title = opened.page?.title
					},
				)
				acp = new ACPServer({
					transport,
					gateway: runtime.gateway,
					commands: new HostCommandRegistry(),
					presenter: runtime.presenter,
					agentInfo: { name: 'namzu', version: 'wire-test' },
					extensions: link.extensions as never,
				} as never)
				await acp.start()
				const init = await call(1, 'initialize', {
					capabilities: ['permission', BROWSER_PANE_CAPABILITY],
				})
				expect(init.error).toBeUndefined()
				const created = await call(2, 'session/new', { cwd, mcpServers: [] })
				session = String((created.result as { sessionId: string }).sessionId)
				const event = link.extensions[BROWSER_PANE_METHODS.event]
				pane.onEvent((e) =>
					event?.({
						sessionId: session,
						kind: 'cdp',
						tabId: e.tabId,
						method: e.method,
						params: e.params,
						...(e.sessionId ? { cdpSessionId: e.sessionId } : {}),
					}),
				)
				const prompted = await call(3, 'session/prompt', {
					sessionId: session,
					prompt: 'open the page',
				})
				expect(prompted.error).toBeUndefined()
				await control()?.dispose()
				await runtime.close()
			} finally {
				await acp?.stop()
				await pane.shutdown()
			}
			expect(title).toBe('Fixture index')
			expect(requests[0]).toBe(BROWSER_PANE_METHODS.open)
			expect(requests).toContain(BROWSER_PANE_METHODS.cdp)
			// The engine let go of the conversation; it did not close the tab the person watches.
			expect(requests.at(-1)).toBe(BROWSER_PANE_METHODS.close)
			expect(released).toEqual(['app-conversation'])
			expect(closedTabs).toBe(0)
		})

		it('opens its own browser, with a note, when the app’s pane cannot be driven', async () => {
			const pane = await chromium.startChromiumPane({ initialTabs: 0 })
			// The app names the capability but has no tab to give.
			const app = fakeApp(pane, true)
			let notes: string | undefined
			let where: unknown
			try {
				await runBrowser(
					{ computerUse: true, browserPane: app.link },
					{ engine: 'local', sites: { [server.allowed]: 'act', '*': 'ask' } },
					async (control) => {
						const opened = await control.host.observe({
							action: 'navigate',
							url: `${server.allowed}/index.html`,
						})
						notes = opened.message
						expect(opened.page?.title).toBe('Fixture index')
						where = control.status().where
					},
				)
			} finally {
				await pane.shutdown()
			}
			expect(notes).toContain('The Browser pane could not be used')
			expect(where).toBe('own')
		})

		it('keeps its own browser, and asks the app for nothing, when the app did not name the pane', async () => {
			const pane = await chromium.startChromiumPane({ initialTabs: 1 })
			const app = fakeApp(pane, false)
			let where: unknown
			let window: unknown
			try {
				await runBrowser(
					{ computerUse: true, browserPane: app.link },
					{ engine: 'local', sites: { [server.allowed]: 'act', '*': 'ask' } },
					async (control) => {
						const opened = await control.host.observe({
							action: 'navigate',
							url: `${server.allowed}/index.html`,
						})
						expect(opened.page?.title).toBe('Fixture index')
						expect(opened.message ?? '').not.toContain('Browser pane')
						where = control.status().where
						// The card keeps its words: a window of the browser's own, or none where it has no display.
						window = handoffWindow(control.status())
					},
				)
			} finally {
				await pane.shutdown()
			}
			expect(where).toBe('own')
			expect(['visible', 'none']).toContain(window)
			expect(app.asked).toEqual([])
		})
	},
)
