import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
		async function runBrowser(
			runtimeOptions: CliAcpRuntimeOptions,
			browserConfig: Record<string, unknown>,
			use: (control: ReturnType<typeof createBrowserControl>) => Promise<void>,
		): Promise<void> {
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
				await control?.dispose()
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
