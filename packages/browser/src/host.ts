import { randomBytes } from 'node:crypto'
import type {
	BrowserActAction,
	BrowserCallOptions,
	BrowserCapabilities,
	BrowserEffect,
	BrowserHost,
	BrowserObserveAction,
	BrowserPageInfo,
	BrowserRefDescription,
	BrowserResult,
	BrowserSessionInfo,
	BrowserSnapshot,
	BrowserSnapshotView,
	BrowserTabInfo,
	BrowserTarget,
	BrowserValue,
} from '@namzu/sdk'
import {
	BROWSER_FIND_MAX_MATCHES,
	canonicalizeBrowserOrigin,
	canonicalizeBrowserUrl,
	resolveNamzuHome,
} from '@namzu/sdk'
import type {
	BrowserContext,
	CDPSession,
	Dialog,
	ElementHandle,
	Locator,
	Page,
	Request,
	Route,
} from 'playwright-core'
import {
	type BrowserHumanClassifierOptions,
	classifyHumanRequired,
	isCredentialField,
} from './classifier.js'
import {
	type BrowserEnginePlan,
	type BrowserEngineSetting,
	type BrowserHeadlessSetting,
	type BrowserRunMode,
	type LocalBrowserPlan,
	type WindowsCdpBrowserPlan,
	detectBrowserEnvironment,
	runnableBrowserPlan,
} from './detect.js'
import {
	BrowserHumanRequiredError,
	BrowserNoEffectError,
	BrowserOriginMismatchError,
	BrowserOutcomeUnknownError,
	BrowserSiteDeniedError,
	BrowserStaleRefError,
	BrowserTargetUnclearError,
	BrowserUnavailableError,
	ProfileBusyError,
} from './errors.js'
import {
	type ElementFieldFacts,
	countCredentialFields,
	fieldFacts,
	hasVisibleContent,
	installMutationClock,
	msSinceLastChange,
	valueFacts,
} from './page-scripts.js'
import { BrowserSitePolicy, type BrowserSiteRules, DEFAULT_BROWSER_SITE_RULES } from './policy.js'
import {
	type BrowserLease,
	BrowserLeaseStore,
	BrowserProfileError,
	BrowserProfileStore,
	DEFAULT_BROWSER_PROFILE,
} from './profiles.js'
import { type SettleOutcome, type SettleProbe, waitUntilQuiet } from './settle.js'
import {
	type Aim,
	CANDIDATES_MAX,
	KEY_DELAY_MS,
	NAMED_KEYS,
	type NamedKey,
	aimInside,
	deepFocus,
	describeCandidate,
	failedBeforeActing,
	focusIsOpaque,
	keyCanCommit,
	namedKey,
	noEffectReason,
} from './reach.js'
import {
	PLAYWRIGHT_CORE_VERSION,
	SnapshotPager,
	buildEffect,
	captureAriaTree,
	diffLines,
	findInTree,
	locateRef,
	renderAriaTree,
	renderInteractive,
	renderReading,
	subtreeOf,
} from './snapshot.js'
import { WindowsBridgeError } from './windows-bridge.js'
import { type WindowsBrowserConnection, connectWindowsBrowser } from './windows-engine.js'

export interface PlaywrightBrowserHostOptions {
	/** Profile to run under. Default `default`. Chosen by the operator, never by the model. */
	readonly profile?: string
	/** `NAMZU_HOME`. Default: resolved from the environment when the browser first starts. */
	readonly home?: string
	/** Names this host's lease on the profile. Default: random. */
	readonly sessionId?: string
	/** The engine plan. Default: {@link detectBrowserEnvironment} over `env` and `platform`. */
	readonly plan?: BrowserEnginePlan
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly engine?: BrowserEngineSetting
	readonly headless?: BrowserHeadlessSetting
	readonly mode?: BrowserRunMode
	/** Site rules for the checks after the fact. Default `{ '*': 'ask' }`. */
	readonly sites?: BrowserSiteRules
	/**
	 * Leave the browser running when this host is disposed. For the Windows
	 * engine this also leaves it running if this process dies.
	 */
	readonly keepOpen?: boolean
	/** Default 30 000. */
	readonly navigationTimeoutMs?: number
	/** Default 10 000. */
	readonly actionTimeoutMs?: number
	/** Snapshot page size in characters. Default and ceiling 20 000. */
	readonly snapshotMaxChars?: number
	/** A browser binary to launch instead of the plan's. */
	readonly executablePath?: string
	/** More sign-in addresses for the classifier. */
	readonly signInAddresses?: BrowserHumanClassifierOptions['signInAddresses']
	/** The command that opens a visible window for signing in. Default `namzu browser login <profile> <url>`. */
	readonly loginCommand?: (profile: string, url: string) => string
	/** Windows engine: how long starting and connecting to the browser may take. Default 60 000. */
	readonly windowsLaunchTimeoutMs?: number
}

interface Tab {
	readonly id: string
	readonly page: Page
	/** Main-frame navigation events, including same-document history moves. */
	mainFrameCommits: number
	mainDocumentResponses: number
	cdp?: CDPSession
	readonly responsesByLoader: Map<string, DocumentResponse>
	/** Requests that can still change the page: documents, scripts, styles, fetch and XHR. */
	readonly inflight: Set<Request>
	/** When a request of that kind last started or ended. */
	lastNetworkAt: number
	/** The whole-page tree the model was last shown for this tab, for `delta` and effects. */
	lastSeen?: string
	/** HTTP status of the main document's last response. */
	status?: number
	wwwAuthenticate?: string
	proxyAuthenticate?: string
}

type DocumentResponse = Pick<Tab, 'status' | 'wwwAuthenticate' | 'proxyAuthenticate'>

interface DocumentResponseCheckpoint {
	readonly previous: DocumentResponse
	readonly loaderId?: string
	readonly responsesBefore: number
	readonly commitsBefore: number
}

interface PendingDialog {
	readonly tab: Tab
	readonly dialog: Dialog
	checkpoint?: DocumentResponseCheckpoint
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const DEFAULT_ACTION_TIMEOUT_MS = 10_000
/** How long a history move waits for the document after it committed. */
const HISTORY_LOAD_WAIT_MS = 5_000
const SNAPSHOT_PAGE_MAX = 20_000
/**
 * A page is quiet after this long with no change to the document and no
 * request in flight. It also bounds how long an event the browser has not
 * announced yet (a popup, a download, a dialog) has to arrive.
 */
const QUIET_MS = 250
/** The most an action waits for quiet. A page that never settles is reported, not waited on. */
const ACT_SETTLE_CAP_MS = 2_000
/** The same for a navigation, which loads more. */
const NAVIGATE_SETTLE_CAP_MS = 5_000
/** The wait before an action, for events left over from the last one. */
const PRE_ACT_QUIET_MS = 100
const PRE_ACT_CAP_MS = 500
/** `wait_for` with `stable` and no time: how long it waits. */
const STABLE_DEFAULT_WAIT_MS = 5_000
/** Request kinds that can change what the page shows. */
const PAGE_REQUEST_KINDS = new Set(['document', 'script', 'stylesheet', 'fetch', 'xhr'])
/** Lines of a `delta` snapshot that are listed in full. */
const DELTA_LINES_SHOWN = 80
/** Lines of an effect the model is shown. */
const EFFECT_LINES_SHOWN = 10
/** Smallest frame that can hold a CAPTCHA a person is meant to solve. */
const CAPTCHA_FRAME_MIN_PX = 30
const REMEMBERED_DOCUMENTS_MAX = 64

/** Something the credential guards can ask about: a located element or a handle to one. */
type Probe = Locator | ElementHandle

function evaluateOn<R>(target: Probe, fn: (element: Element) => R): Promise<R> {
	return 'asElement' in target
		? (target as ElementHandle).evaluate(fn)
		: (target as Locator).evaluate(fn)
}
const SCREENSHOT_INPUT_MASK_COLOR = '#666666'
/** Most inputs one screenshot checks for a credential. */
const MASK_CANDIDATES_MAX = 200

function firstLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)
	return (text.split('\n')[0] ?? '').slice(0, 300)
}

/** The page's origin as the header shows it: canonical, or `null` for anything that is not a web page. */
function originOf(url: string): string {
	if (url === 'about:blank' || url === '') return 'null'
	const verdict = canonicalizeBrowserUrl(url)
	if (verdict.ok) return verdict.url === 'about:blank' ? 'null' : verdict.origin
	return 'null'
}

function withoutQuery(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.origin}${parsed.pathname}`
	} catch {
		return url
	}
}

function pngSize(data: Uint8Array): { width: number; height: number } {
	if (data.length < 24) return { width: 0, height: 0 }
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}

function quoteShort(value: string, max = 80): string {
	const flat = value.replace(/\s+/g, ' ').trim()
	return JSON.stringify(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat)
}

/**
 * A {@link BrowserHost} that runs Chromium (or an installed Chrome or Edge)
 * in this process with Playwright, on a persistent profile. Inside WSL it
 * drives the Windows Chrome or Edge instead, through the PowerShell bridge
 * (`windows-engine.ts`).
 *
 * Nothing starts at construction: the browser is launched by the first call
 * that needs it, so mounting the tools costs nothing until the model uses
 * them.
 *
 * What it enforces, whatever the gate allowed:
 *
 * - every `browser_act` call's `origin` equals the live page's, checked
 *   immediately before acting;
 * - a page that a navigation, redirect, script or popup lands on must be
 *   allowed by the site rules at `read` or `act`, or be an address the caller
 *   asked to open this session, or `about:blank`. A top-level request to
 *   anything else is blocked before it is sent; a redirect is caught when it
 *   lands, and the tab is cleared to `about:blank`;
 * - acting needs the live origin at `ask` or `act`;
 * - a sign-in, second factor, CAPTCHA, bot wall or HTTP authentication challenge
 *   stops the call with `browser_human_required`;
 * - nothing is ever typed into a password or one-time-code field;
 * - downloads are cancelled and reported; a leave-page prompt is answered so
 *   navigation proceeds; other dialogs wait for `browser_act dialog`.
 */
export class PlaywrightBrowserHost implements BrowserHost {
	readonly id: string
	readonly capabilities: BrowserCapabilities
	readonly plan: BrowserEnginePlan
	readonly profile: string

	private readonly options: PlaywrightBrowserHostOptions
	private readonly policy: BrowserSitePolicy
	private readonly sessionId: string
	private readonly pager: SnapshotPager

	private context: BrowserContext | undefined
	private windows: WindowsBrowserConnection | undefined
	private launching: Promise<BrowserContext> | undefined
	private lease: BrowserLease | undefined
	private readonly tabs = new Map<string, Tab>()
	private readonly tabOf = new WeakMap<Page, Tab>()
	private tabCounter = 0
	private activeTabId: string | undefined
	private ownPageOpening = false
	private pendingDialog: PendingDialog | undefined
	private readonly notes: string[] = []
	private readonly blanking = new Set<Promise<unknown>>()
	private refs: ReadonlyMap<string, BrowserRefDescription> = new Map()

	constructor(options: PlaywrightBrowserHostOptions = {}) {
		this.options = options
		this.profile = options.profile ?? DEFAULT_BROWSER_PROFILE
		this.sessionId = options.sessionId ?? `s${randomBytes(6).toString('hex')}`
		this.policy = new BrowserSitePolicy(options.sites ?? DEFAULT_BROWSER_SITE_RULES)
		const detected =
			options.plan ??
			detectBrowserEnvironment(
				options.env ?? process.env,
				options.platform ?? process.platform,
				undefined,
				{
					...(options.engine ? { engine: options.engine } : {}),
					...(options.headless ? { headless: options.headless } : {}),
					...(options.mode ? { mode: options.mode } : {}),
				},
			)
		this.plan = runnableBrowserPlan(detected)
		const pageChars = Math.min(options.snapshotMaxChars ?? SNAPSHOT_PAGE_MAX, SNAPSHOT_PAGE_MAX)
		this.pager = new SnapshotPager(pageChars)
		this.id = `playwright-${this.plan.engine === 'local' ? this.plan.browser : this.plan.engine}`
		this.capabilities = {
			engine: this.plan.engine === 'local' ? `local-${this.plan.browser}` : this.plan.engine,
			headless: this.plan.headless,
			screenshot: true,
			upload: true,
			snapshotMaxChars: pageChars,
			...(this.plan.unavailableReason !== undefined
				? { unavailableReason: this.plan.unavailableReason }
				: {}),
		}
	}

	/** Warnings from engine detection, for the operator. */
	get warnings(): readonly string[] {
		return this.plan.warnings
	}

	/** Whether the browser is running now. */
	get running(): boolean {
		return this.context !== undefined
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	private async ensureContext(): Promise<BrowserContext> {
		if (this.context) return this.context
		if (!this.launching) {
			this.launching = this.launch().finally(() => {
				this.launching = undefined
			})
		}
		return this.launching
	}

	private async launch(): Promise<BrowserContext> {
		const plan = this.plan
		if (plan.unavailableReason !== undefined)
			throw new BrowserUnavailableError(plan.unavailableReason)
		const context =
			plan.engine === 'local' ? await this.launchLocal(plan) : await this.launchWindows(plan)
		this.context = context
		context.setDefaultTimeout(this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
		context.setDefaultNavigationTimeout(
			this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
		)
		// Every new document keeps a clock of its last change, for the quiet-page wait.
		await context.addInitScript(installMutationClock).catch(() => undefined)
		context.on('page', (page) => this.adopt(page))
		context.on('close', () => this.forget(context))
		context.browser()?.on('disconnected', () => this.forget(context))
		// Before a top-level request leaves: a link, script or popup heading for
		// a site the rules do not allow is stopped here, so its address (and
		// anything a page smuggled into it) never reaches the network.
		await context.route(
			() => true,
			(route) => this.screen(route),
		)
		for (const page of context.pages()) {
			this.adopt(page, false)
			void page.evaluate(installMutationClock).catch(() => undefined)
		}
		return context
	}

	private home(): string {
		return this.options.home ?? resolveNamzuHome({ env: this.options.env ?? process.env })
	}

	private async launchLocal(plan: LocalBrowserPlan): Promise<BrowserContext> {
		const home = this.home()
		const profiles = new BrowserProfileStore(home)
		const descriptor = profiles.ensureLocal(this.profile, plan.browser)
		const lease = new BrowserLeaseStore(home).acquire(this.profile, this.sessionId, {
			exclusive: true,
		})
		let context: BrowserContext
		try {
			// Loaded here, on the first browser launch: playwright-core is several
			// megabytes of source that a session which never opens a browser must
			// not compile at startup.
			const { chromium } = await import('playwright-core')
			context = await chromium.launchPersistentContext(descriptor.userDataDir, {
				headless: plan.headless,
				...(plan.channel ? { channel: plan.channel } : {}),
				...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
				acceptDownloads: false,
				// The terminal owns Ctrl-C; the browser closes with the host.
				handleSIGINT: false,
				...(plan.headless ? {} : { viewport: null }),
				timeout: 60_000,
			})
		} catch (error) {
			lease.release()
			throw this.launchError(error)
		}
		this.lease = lease
		return context
	}

	/**
	 * The Windows browser, through the PowerShell bridge. The profile lives on
	 * the Windows side; its descriptor here records where. Leases are shared:
	 * every namzu process on the profile drives the same browser, and the
	 * last one to let go closes it.
	 */
	private async launchWindows(plan: WindowsCdpBrowserPlan): Promise<BrowserContext> {
		const home = this.home()
		const profiles = new BrowserProfileStore(home)
		const existing = profiles.get(this.profile)
		if (existing && existing.engine !== 'windows-cdp') {
			throw new BrowserProfileError(
				`Browser profile "${this.profile}" belongs to the ${existing.engine} engine, not the Windows browser. Use another profile name.`,
			)
		}
		if (existing && existing.browser !== plan.browser) {
			throw new BrowserProfileError(
				`Browser profile "${this.profile}" was made with ${existing.browser}, and this run would use ${plan.browser}. Use another profile name, or the browser the profile was made with.`,
			)
		}
		const lease = new BrowserLeaseStore(home).acquire(this.profile, this.sessionId)
		let connection: WindowsBrowserConnection
		try {
			connection = await connectWindowsBrowser({
				plan,
				profile: this.profile,
				...(existing ? { userDataDir: existing.userDataDir } : {}),
				closeOnExit: !this.options.keepOpen,
				env: this.options.env ?? process.env,
				...(this.options.windowsLaunchTimeoutMs !== undefined
					? { timeoutMs: this.options.windowsLaunchTimeoutMs }
					: {}),
				onDownloadRefused: (name) => {
					this.notes.push(
						`A download of ${quoteShort(name)} was cancelled: the browser does not download files.`,
					)
				},
			})
		} catch (error) {
			lease.release()
			throw this.windowsLaunchError(plan, error)
		}
		try {
			profiles.ensureWindows(this.profile, plan.browser, connection.userDataDir)
		} catch (error) {
			lease.release()
			await connection.detach().catch(() => undefined)
			throw error
		}
		this.lease = lease
		this.windows = connection
		return connection.context
	}

	private windowsLaunchError(plan: WindowsCdpBrowserPlan, error: unknown): Error {
		const name = plan.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'
		if (error instanceof WindowsBridgeError) {
			if (error.code === 'browser-exited') return new ProfileBusyError(this.profile, [])
			return new BrowserUnavailableError(
				`The Windows ${name} could not be started from WSL: ${error.message}`,
			)
		}
		return new BrowserUnavailableError(
			`The Windows ${name} was started but could not be driven from WSL: ${firstLine(error)}`,
		)
	}

	private launchError(error: unknown): Error {
		const text = error instanceof Error ? error.message : String(error)
		if (
			/Executable doesn't exist|executable doesn't exist|browserType\.launch.*not found/i.test(text)
		) {
			const which =
				this.plan.engine === 'local' && this.plan.browser !== 'chromium'
					? `The installed ${this.plan.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} was not found where it should be.`
					: `Playwright's Chromium for playwright-core ${PLAYWRIGHT_CORE_VERSION} is not installed.`
			return new BrowserUnavailableError(
				`${which} Run \`namzu browser install\` (or \`npx playwright-core@${PLAYWRIGHT_CORE_VERSION} install chromium\`).`,
			)
		}
		if (/ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(text)) {
			return new ProfileBusyError(this.profile, [])
		}
		if (/Missing X server|cannot open display|\$DISPLAY/i.test(text)) {
			return new BrowserUnavailableError(
				'The browser needs a display for a visible window and could not open one. Run headless, or under a desktop session.',
			)
		}
		return new BrowserUnavailableError(`The browser could not start: ${firstLine(error)}`)
	}

	private forget(context: BrowserContext): void {
		if (this.context !== context) return
		this.context = undefined
		const windows = this.windows
		this.windows = undefined
		if (windows) void windows.detach().catch(() => undefined)
		this.tabs.clear()
		this.activeTabId = undefined
		this.pendingDialog = undefined
		this.refs = new Map()
		this.lease?.release()
		this.lease = undefined
	}

	async initialize(): Promise<void> {
		// Deliberately nothing: the browser starts on first use.
	}

	/**
	 * Release this host's lease. The browser closes when that was the last
	 * lease on the profile, unless `keepOpen` was set.
	 */
	async dispose(): Promise<void> {
		const lease = this.lease
		this.lease = undefined
		const last = lease ? lease.release().last : true
		if (last && !this.options.keepOpen) {
			await this.close()
			return
		}
		// The Windows browser is shared with every other holder of the
		// profile, or is to stay open: disconnect without closing it.
		const context = this.context
		const windows = this.windows
		if (!context || !windows) return
		this.windows = undefined
		this.forget(context)
		await windows.detach().catch(() => undefined)
	}

	/** Close the browser now, whatever the leases say. */
	async close(): Promise<void> {
		const context = this.context
		if (!context) return
		const windows = this.windows
		this.windows = undefined
		this.forget(context)
		if (windows) await windows.close().catch(() => undefined)
		else await context.close().catch(() => undefined)
	}

	// -------------------------------------------------------------------------
	// Tabs and events
	// -------------------------------------------------------------------------

	private adopt(page: Page, announce = true): Tab {
		const known = this.tabOf.get(page)
		if (known) return known
		this.tabCounter += 1
		const tab: Tab = {
			id: `t${this.tabCounter}`,
			page,
			mainFrameCommits: 0,
			mainDocumentResponses: 0,
			responsesByLoader: new Map(),
			inflight: new Set(),
			lastNetworkAt: Date.now(),
		}
		this.tabs.set(tab.id, tab)
		this.tabOf.set(page, tab)
		if (this.activeTabId === undefined) this.activeTabId = tab.id
		if (announce && !this.ownPageOpening) {
			this.notes.push(
				`The page opened a new tab, ${tab.id}; it is not the active tab. Use tabs list or select to look at it.`,
			)
		}
		page.on('framenavigated', (frame) => {
			if (frame === page.mainFrame()) {
				tab.mainFrameCommits += 1
				this.checkLanding(tab)
			}
		})
		page.on('response', (response) => {
			try {
				if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
					const headers = response.headers()
					tab.mainDocumentResponses += 1
					tab.status = response.status()
					tab.wwwAuthenticate = headers['www-authenticate']
					tab.proxyAuthenticate = headers['proxy-authenticate']
				}
			} catch {
				// A response without a frame (a service worker's) says nothing about the page.
			}
		})
		const kind = (request: Request): boolean => PAGE_REQUEST_KINDS.has(request.resourceType())
		page.on('request', (request) => {
			if (!kind(request)) return
			tab.inflight.add(request)
			tab.lastNetworkAt = Date.now()
		})
		const ended = (request: Request): void => {
			if (tab.inflight.delete(request)) tab.lastNetworkAt = Date.now()
		}
		page.on('requestfinished', ended)
		page.on('requestfailed', ended)
		page.on('dialog', (dialog) => this.onDialog(tab, dialog))
		page.on('download', (download) => {
			const name = download.suggestedFilename()
			this.notes.push(
				`A download of ${quoteShort(name)} was cancelled: the browser does not download files.`,
			)
			void download.cancel().catch(() => undefined)
		})
		page.on('close', () => {
			this.tabs.delete(tab.id)
			if (this.pendingDialog?.tab === tab) this.pendingDialog = undefined
			if (this.activeTabId === tab.id) this.activeTabId = [...this.tabs.keys()].pop()
		})
		return tab
	}

	private onDialog(tab: Tab, dialog: Dialog): void {
		if (dialog.type() === 'beforeunload') {
			// The call that left the page was approved; a "leave site?" prompt
			// would otherwise hold the navigation until it timed out.
			void dialog.accept().catch(() => undefined)
			this.notes.push('The page asked before leaving; it was left.')
			return
		}
		if (this.pendingDialog) {
			void dialog.dismiss().catch(() => undefined)
			return
		}
		this.pendingDialog = { tab, dialog }
		this.notes.push(
			`A ${dialog.type()} dialog is open on tab ${tab.id}. Take a snapshot to read it, then dismiss it with browser_act dialog or ask the operator to use the browser window.`,
		)
	}

	/** The route handler: stop top-level navigations the policy does not allow. */
	private async screen(route: Route): Promise<void> {
		const request = route.request()
		let topLevel = false
		if (request.isNavigationRequest()) {
			try {
				topLevel = request.frame().parentFrame() === null
			} catch {
				// A popup's first request is issued before its frame exists; it is
				// the top-level document of the new tab.
				topLevel = true
			}
		}
		if (topLevel) {
			const verdict = this.policy.landing(request.url())
			if (!verdict.allowed) {
				this.notes.push(
					`A navigation to ${verdict.origin} was blocked before it was sent: ${verdict.reason}. To go there, open it with navigate.`,
				)
				// `aborted`, not `blockedbyclient`: Chromium commits an error page
				// for the latter, which would replace the page the tab was on.
				await route.abort('aborted').catch(() => undefined)
				return
			}
		}
		await route.fallback().catch(() => undefined)
	}

	/** After a navigation lands: clear the tab if the policy does not allow where it is. */
	private checkLanding(tab: Tab): void {
		const url = tab.page.url()
		const verdict = this.policy.landing(url)
		if (verdict.allowed) return
		this.notes.push(
			`Tab ${tab.id} ended up on ${verdict.origin}: ${verdict.reason}. It was cleared to about:blank.`,
		)
		const blank = tab.page
			.goto('about:blank')
			.catch(() => undefined)
			.finally(() => this.blanking.delete(blank))
		this.blanking.add(blank)
	}

	/**
	 * Wait until the tab's page is quiet (nothing changed in it and no request
	 * in flight for `quietMs`), or `capMs` has passed. Events the browser
	 * announces late (a popup, a download, a dialog) arrive inside the window.
	 * Then let any tab that was cleared to `about:blank` finish clearing.
	 */
	private async settle(
		tab: Tab,
		options: { readonly quietMs: number; readonly capMs: number } = {
			quietMs: QUIET_MS,
			capMs: ACT_SETTLE_CAP_MS,
		},
	): Promise<SettleOutcome> {
		const outcome = await waitUntilQuiet(
			{ now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
			this.quietProbe(tab),
			options,
		)
		while (this.blanking.size > 0) await Promise.all([...this.blanking])
		return outcome
	}

	private quietProbe(tab: Tab): SettleProbe {
		return {
			stillForMs: async () => {
				// A dialog pauses the page; nothing more will happen until it is answered.
				if (this.pendingDialog?.tab === tab || tab.page.isClosed()) return Number.MAX_SAFE_INTEGER
				if (tab.inflight.size > 0) return 0
				const sinceNetwork = Date.now() - tab.lastNetworkAt
				const sincePage = await Promise.race([
					tab.page.evaluate(msSinceLastChange).catch(() => 0),
					new Promise<number>((resolve) => setTimeout(() => resolve(0), 1000)),
				])
				return Math.min(sinceNetwork, sincePage)
			},
		}
	}

	private async activeTab(): Promise<Tab> {
		const context = await this.ensureContext()
		const current = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
		if (current && !current.page.isClosed()) return current
		const page = await this.openOwnPage(context)
		const tab = this.adopt(page, false)
		this.activeTabId = tab.id
		return tab
	}

	private async openOwnPage(context: BrowserContext): Promise<Page> {
		this.ownPageOpening = true
		try {
			return await context.newPage()
		} finally {
			this.ownPageOpening = false
		}
	}

	private drainNotes(): string | undefined {
		if (this.notes.length === 0) return undefined
		const text = this.notes.join(' ')
		this.notes.length = 0
		return text
	}

	private async title(tab: Tab): Promise<string> {
		if (this.pendingDialog?.tab === tab) return ''
		return Promise.race([
			tab.page.title().catch(() => ''),
			new Promise<string>((resolve) => setTimeout(() => resolve(''), 1000)),
		])
	}

	private async pageInfo(tab: Tab): Promise<BrowserPageInfo> {
		const url = tab.page.url()
		return {
			origin: originOf(url),
			url,
			title: await this.title(tab),
			tab: tab.id,
		}
	}

	private result(extra: Omit<BrowserResult, 'message'>): BrowserResult {
		const message = this.drainNotes()
		return { ...extra, ...(message !== undefined ? { message } : {}) }
	}

	// -------------------------------------------------------------------------
	// Human handoff
	// -------------------------------------------------------------------------

	private loginCommandFor(url: string): string {
		const target = withoutQuery(url)
		return this.options.loginCommand
			? this.options.loginCommand(this.profile, target)
			: `namzu browser login ${this.profile} ${target}`
	}

	private humanRequired(
		reason: BrowserHumanRequiredError['reason'],
		tab: Tab,
	): BrowserHumanRequiredError {
		const url = tab.page.url()
		return new BrowserHumanRequiredError(reason, originOf(url), {
			profile: this.profile,
			loginCommand: this.loginCommandFor(url),
		})
	}

	/** Throw `browser_human_required` if the page needs a person. */
	private async checkHuman(tab: Tab): Promise<void> {
		const page = tab.page
		const url = page.url()
		if (originOf(url) === 'null' || this.pendingDialog?.tab === tab) return
		const counts = await page
			.evaluate(countCredentialFields)
			.catch(() => ({ passwordFields: 0, oneTimeCodeFields: 0 }))
		const frameUrls: string[] = []
		for (const frame of page.frames()) {
			if (frame === page.mainFrame()) continue
			try {
				const element = await frame.frameElement()
				const box = await element.boundingBox()
				if (box && box.width >= CAPTCHA_FRAME_MIN_PX && box.height >= CAPTCHA_FRAME_MIN_PX) {
					frameUrls.push(frame.url())
				}
			} catch {
				// A frame that went away while we looked is not a challenge.
			}
		}
		const reason = classifyHumanRequired(
			{
				url,
				title: await this.title(tab),
				...(tab.status !== undefined ? { status: tab.status } : {}),
				...(tab.wwwAuthenticate !== undefined ? { wwwAuthenticate: tab.wwwAuthenticate } : {}),
				...(tab.proxyAuthenticate !== undefined
					? { proxyAuthenticate: tab.proxyAuthenticate }
					: {}),
				...counts,
				frameUrls,
			},
			this.options.signInAddresses ? { signInAddresses: this.options.signInAddresses } : {},
		)
		if (reason) throw this.humanRequired(reason, tab)
		if (tab.status === 401) {
			throw new Error(
				'The site returned HTTP 401 without a WWW-Authenticate challenge. Access was denied or the response is incomplete; no HTTP password prompt was identified. Tell the user the site refused this request.',
			)
		}
		if (tab.status === 407) {
			throw new Error(
				'The proxy returned HTTP 407 without a Proxy-Authenticate challenge. Access was denied or the response is incomplete; no proxy password prompt was identified. Tell the user the proxy refused this request.',
			)
		}
	}

	private documentResponse(tab: Tab): DocumentResponse {
		return {
			status: tab.status,
			wwwAuthenticate: tab.wwwAuthenticate,
			proxyAuthenticate: tab.proxyAuthenticate,
		}
	}

	private clearDocumentResponse(tab: Tab): void {
		tab.status = undefined
		tab.wwwAuthenticate = undefined
		tab.proxyAuthenticate = undefined
	}

	private setDocumentResponse(tab: Tab, response: DocumentResponse): void {
		tab.status = response.status
		tab.wwwAuthenticate = response.wwwAuthenticate
		tab.proxyAuthenticate = response.proxyAuthenticate
	}

	/** Chromium's loader ID belongs to a document, and survives same-document history moves. */
	private async loaderId(tab: Tab): Promise<string | undefined> {
		try {
			tab.cdp ??= await tab.page.context().newCDPSession(tab.page)
			const tree = (await tab.cdp.send('Page.getFrameTree')) as {
				frameTree?: { frame?: { loaderId?: unknown } }
			}
			const id = tree.frameTree?.frame?.loaderId
			return typeof id === 'string' && id.length > 0 ? id : undefined
		} catch {
			tab.cdp = undefined
			return undefined
		}
	}

	private rememberDocumentResponse(tab: Tab, loaderId: string, response: DocumentResponse): void {
		tab.responsesByLoader.delete(loaderId)
		tab.responsesByLoader.set(loaderId, response)
		if (tab.responsesByLoader.size > REMEMBERED_DOCUMENTS_MAX) {
			const oldest = tab.responsesByLoader.keys().next().value
			if (oldest !== undefined) tab.responsesByLoader.delete(oldest)
		}
	}

	private async beginDocumentResponseChange(tab: Tab): Promise<DocumentResponseCheckpoint> {
		const loaderId = await this.loaderId(tab)
		const previous = this.documentResponse(tab)
		if (loaderId !== undefined) this.rememberDocumentResponse(tab, loaderId, previous)
		const checkpoint = {
			previous,
			...(loaderId !== undefined ? { loaderId } : {}),
			responsesBefore: tab.mainDocumentResponses,
			commitsBefore: tab.mainFrameCommits,
		}
		this.clearDocumentResponse(tab)
		return checkpoint
	}

	private async finishDocumentResponseChange(
		tab: Tab,
		checkpoint: DocumentResponseCheckpoint,
	): Promise<void> {
		if (this.pendingDialog?.tab === tab) {
			// CDP page queries wait behind an open JavaScript dialog. The page
			// cannot commit a navigation until the dialog is answered.
			this.pendingDialog.checkpoint = checkpoint
			this.setDocumentResponse(tab, checkpoint.previous)
			return
		}
		const currentLoader = await this.loaderId(tab)
		const freshResponse = tab.mainDocumentResponses !== checkpoint.responsesBefore
		const committed =
			(currentLoader !== undefined &&
				checkpoint.loaderId !== undefined &&
				currentLoader !== checkpoint.loaderId) ||
			tab.mainFrameCommits !== checkpoint.commitsBefore
		if (currentLoader !== undefined && currentLoader === checkpoint.loaderId) {
			// A hash change, pushState, no-op, or failed request left this document in place.
			this.setDocumentResponse(tab, checkpoint.previous)
		} else if (freshResponse && committed) {
			// A new main-document response and a committed navigation agree.
		} else if (freshResponse) {
			this.setDocumentResponse(tab, checkpoint.previous)
			throw new Error(
				'The browser received a document response but could not confirm that it replaced the current page. Its access status is unknown; do not treat this as a successful page load.',
			)
		} else if (!freshResponse && currentLoader && tab.responsesByLoader.has(currentLoader)) {
			// Back-forward cache restores a document without another response event.
			this.setDocumentResponse(tab, tab.responsesByLoader.get(currentLoader) as DocumentResponse)
		} else if (!freshResponse && !committed) {
			// CDP can be unavailable while the browser is closing; no frame moved.
			this.setDocumentResponse(tab, checkpoint.previous)
		} else if (!freshResponse && originOf(tab.page.url()) !== 'null') {
			throw new Error(
				'The browser moved to a page without a response that could be verified. Its access status is unknown; do not treat this as a successful page load.',
			)
		}
		if (currentLoader !== undefined) {
			this.rememberDocumentResponse(tab, currentLoader, this.documentResponse(tab))
		}
	}

	// -------------------------------------------------------------------------
	// Calls
	// -------------------------------------------------------------------------

	private async guarded<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
		if (signal?.aborted) throw new Error('The browser call was cancelled.')
		if (!signal) return run()
		let onAbort: (() => void) | undefined
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error('The browser call was cancelled.'))
			signal.addEventListener('abort', onAbort, { once: true })
		})
		try {
			return await Promise.race([run(), aborted])
		} finally {
			if (onAbort) signal.removeEventListener('abort', onAbort)
		}
	}

	async observe(
		action: BrowserObserveAction,
		options?: BrowserCallOptions,
	): Promise<BrowserResult> {
		return this.guarded(options?.signal, () => this.runObserve(action))
	}

	async act(action: BrowserActAction, options?: BrowserCallOptions): Promise<BrowserResult> {
		return this.guarded(options?.signal, () => this.runAct(action))
	}

	private async runObserve(action: BrowserObserveAction): Promise<BrowserResult> {
		switch (action.action) {
			case 'navigate':
				return this.navigate(await this.activeTab(), action.url)
			case 'back':
			case 'forward':
			case 'reload':
				return this.history(action.action)
			case 'snapshot':
				return this.snapshot(action)
			case 'screenshot':
				return this.screenshot(action.ref, action.fullPage)
			case 'scroll':
				return this.scroll(action.direction, action.ref, action.amount)
			case 'wait_for':
				return this.waitFor(action)
			case 'tabs':
				return this.tabsCall(action)
			case 'value':
				return this.readValue(action.ref)
		}
	}

	private async navigate(tab: Tab, rawUrl: string): Promise<BrowserResult> {
		const verdict = canonicalizeBrowserUrl(rawUrl)
		if (!verdict.ok)
			throw new BrowserSiteDeniedError('', `The address was refused: ${verdict.reason}`)
		if (verdict.url !== 'about:blank') {
			const level = this.policy.levelOf(verdict.origin)
			if (level === 'deny') throw new BrowserSiteDeniedError(verdict.origin)
			this.policy.approve(verdict.origin)
		}
		await this.dismissPendingDialog(tab)
		const checkpoint = await this.beginDocumentResponseChange(tab)
		try {
			await tab.page.goto(verdict.url, { waitUntil: 'domcontentloaded' })
		} catch (error) {
			await this.finishDocumentResponseChange(tab, checkpoint).catch(() => undefined)
			if (/ERR_UNEXPECTED_PROXY_AUTH/.test(firstLine(error))) {
				await this.settle(tab)
				throw new Error(
					'The browser refused an HTTP 407 proxy response before the page loaded. Proxy access is unavailable or its response is invalid; no usable password prompt was identified. Tell the user the proxy refused this request.',
				)
			}
			if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|Download is starting/.test(firstLine(error))) {
				throw new Error(`Could not open ${verdict.url}: ${firstLine(error)}`)
			}
		}
		await this.finishDocumentResponseChange(tab, checkpoint)
		return this.afterNavigation(tab)
	}

	private async afterNavigation(tab: Tab): Promise<BrowserResult> {
		// The document first (a page that has not finished loading has not
		// finished building itself), then the same quiet the actions wait for.
		await tab.page
			.waitForLoadState('load', { timeout: NAVIGATE_SETTLE_CAP_MS })
			.catch(() => undefined)
		const settled = await this.settle(tab, { quietMs: QUIET_MS, capMs: NAVIGATE_SETTLE_CAP_MS })
		this.checkLanding(tab)
		while (this.blanking.size > 0) await Promise.all([...this.blanking])
		await this.checkHuman(tab)
		if (!settled.quiet) {
			this.notes.push(
				`The page was still changing after ${settled.waitedMs} ms, so what it shows may be unfinished. Call browser with wait_for and stable, or take a snapshot.`,
			)
		}
		const populated =
			originOf(tab.page.url()) === 'null' ||
			(await tab.page.evaluate(hasVisibleContent).catch(() => true))
		if (!populated) {
			this.notes.push(
				`The page has nothing to read yet (waited ${settled.waitedMs} ms). Call browser with wait_for and stable, or reload.`,
			)
		}
		// The model's next step after opening a page is to read it, so the
		// reading comes with the open: one request fewer on every page visit.
		if (populated && originOf(tab.page.url()) !== 'null') {
			try {
				const snapshot = await this.takeSnapshot(tab)
				return this.result({ page: snapshot.page, snapshot })
			} catch {
				// An unreadable page still opened; say where we are and let the model ask again.
			}
		}
		return this.result({ page: await this.pageInfo(tab) })
	}

	private async history(which: 'back' | 'forward' | 'reload'): Promise<BrowserResult> {
		const tab = await this.activeTab()
		await this.dismissPendingDialog(tab)
		const checkpoint = await this.beginDocumentResponseChange(tab)
		// `commit`, then the document as a bonus: a page restored from the
		// back-forward cache fires no `domcontentloaded`, so waiting for it
		// timed out after a history move that had long finished (measured
		// with the Windows engine: 30 s, then a failure, on a page that was
		// already back).
		const options = { waitUntil: 'commit' as const }
		const before = tab.page.url()
		let response: unknown = true
		try {
			response =
				which === 'back'
					? await tab.page.goBack(options)
					: which === 'forward'
						? await tab.page.goForward(options)
						: await tab.page.reload(options)
		} catch (error) {
			await this.finishDocumentResponseChange(tab, checkpoint).catch(() => undefined)
			if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(firstLine(error))) throw error
		}
		await this.finishDocumentResponseChange(tab, checkpoint)
		if (response !== null) {
			await tab.page
				.waitForLoadState('domcontentloaded', { timeout: HISTORY_LOAD_WAIT_MS })
				.catch(() => undefined)
		}
		// `null` is also what a restore from the back-forward cache returns:
		// no network response. Only an unchanged address means nowhere to go.
		if (response === null && which !== 'reload' && tab.page.url() === before) {
			this.notes.push(`There is no page to go ${which} to.`)
		}
		return this.afterNavigation(tab)
	}

	private async dismissPendingDialog(tab: Tab): Promise<void> {
		const pending = this.pendingDialog
		if (!pending || pending.tab !== tab) return
		this.pendingDialog = undefined
		await pending.dialog.dismiss().catch(() => undefined)
		this.notes.push('The open dialog was dismissed.')
	}

	/** Read the page's tree and remember its refs. */
	private async readTree(tab: Tab) {
		const { nodes, hidden, redact } = await captureAriaTree(
			tab.page,
			this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
		)
		const whole = renderAriaTree(nodes, hidden, undefined, redact)
		if (!whole) throw new Error('The page could not be read.')
		this.refs = whole.refs
		return { nodes, hidden, redact, whole }
	}

	private async takeSnapshot(
		tab: Tab,
		request: {
			readonly ref?: string
			readonly view?: BrowserSnapshotView
			readonly query?: string
			readonly role?: string
		} = {},
	): Promise<BrowserSnapshot> {
		const pending = this.pendingDialog
		if (pending && pending.tab === tab) {
			const dialog = pending.dialog
			const lines = [
				`- dialog (${dialog.type()}) ${JSON.stringify(dialog.message().replace(/\s+/g, ' ').trim())}`,
			]
			if (dialog.type() === 'prompt')
				lines.push(`  - /default: ${JSON.stringify(dialog.defaultValue())}`)
			lines.push('  - (the page is paused until the dialog is answered)')
			return { page: await this.pageInfo(tab), text: lines.join('\n') }
		}
		const { ref, view = 'full', query, role } = request
		const { nodes, hidden, redact, whole } = await this.readTree(tab)
		if (ref !== undefined && !whole.refs.has(ref)) throw new BrowserStaleRefError(ref)
		// A region is cut from the whole-page tree: a snapshot of one element would replace the ref table.
		const scope = ref === undefined ? nodes : (subtreeOf(nodes, ref) ?? [])
		let text: string
		if (query !== undefined || role !== undefined) {
			const found = findInTree(
				scope,
				hidden,
				redact,
				{ ...(query !== undefined ? { query } : {}), ...(role !== undefined ? { role } : {}) },
				BROWSER_FIND_MAX_MATCHES,
			)
			text = found.lines.join('\n')
			const what = [
				query !== undefined ? `text ${quoteShort(query, 60)}` : '',
				role !== undefined ? `role ${quoteShort(role, 30)}` : '',
			]
				.filter(Boolean)
				.join(' and ')
			this.notes.unshift(
				found.total === 0
					? `Nothing on the page matches ${what}.`
					: found.total > found.lines.length
						? `${found.total} elements match ${what}; the first ${found.lines.length} are listed. Narrow the search.`
						: `${found.total} element${found.total === 1 ? '' : 's'} match${found.total === 1 ? 'es' : ''} ${what}.`,
			)
		} else if (view === 'interactive') {
			text = renderInteractive(scope, hidden, redact)
			tab.lastSeen = whole.text
		} else if (view === 'reading') {
			text = renderReading(scope, hidden, redact)
			tab.lastSeen = whole.text
		} else if (view === 'delta') {
			const before = tab.lastSeen
			if (before === undefined) {
				this.notes.unshift(
					'There is no earlier snapshot of this tab to compare with; this is the whole page.',
				)
				text =
					ref === undefined ? whole.text : (renderAriaTree(nodes, hidden, ref, redact)?.text ?? '')
			} else {
				const diff = diffLines(before, whole.text, DELTA_LINES_SHOWN)
				text =
					diff.added === 0 && diff.removed === 0
						? '(no change since the last snapshot)'
						: [
								...diff.addedLines.map((l) => `+ ${l}`),
								...(diff.added > diff.addedLines.length
									? [`  (${diff.added - diff.addedLines.length} more lines added)`]
									: []),
								...diff.removedLines.map((l) => `- ${l}`),
								...(diff.removed > diff.removedLines.length
									? [`  (${diff.removed - diff.removedLines.length} more lines removed)`]
									: []),
							].join('\n')
				this.notes.unshift(
					`Changes since the last snapshot: ${diff.added} lines added, ${diff.removed} removed. Take a full snapshot to see the whole page again.`,
				)
			}
			tab.lastSeen = whole.text
		} else {
			text =
				ref === undefined ? whole.text : (renderAriaTree(nodes, hidden, ref, redact)?.text ?? '')
			if (ref === undefined) tab.lastSeen = whole.text
		}
		if (text.trim() === '') text = '(nothing readable on this page)'
		const first = this.pager.start(text)
		return {
			page: await this.pageInfo(tab),
			text: first.text,
			...(first.nextCursor !== undefined ? { nextCursor: first.nextCursor } : {}),
		}
	}

	private async snapshot(
		request: Extract<BrowserObserveAction, { action: 'snapshot' }>,
	): Promise<BrowserResult> {
		const tab = await this.activeTab()
		if (request.cursor !== undefined) {
			const next = this.pager.resume(request.cursor)
			if (!next) {
				throw new Error(
					'That cursor belongs to an older snapshot. Take a new snapshot and page through it.',
				)
			}
			return this.result({
				snapshot: {
					page: await this.pageInfo(tab),
					text: next.text,
					...(next.nextCursor !== undefined ? { nextCursor: next.nextCursor } : {}),
				},
			})
		}
		await this.settle(tab, { quietMs: PRE_ACT_QUIET_MS, capMs: PRE_ACT_CAP_MS })
		return this.result({
			snapshot: await this.takeSnapshot(tab, {
				...(request.ref !== undefined ? { ref: request.ref } : {}),
				...(request.view !== undefined ? { view: request.view } : {}),
				...(request.query !== undefined ? { query: request.query } : {}),
				...(request.role !== undefined ? { role: request.role } : {}),
			}),
		})
	}

	private async resolveRef(tab: Tab, ref: string): Promise<Locator> {
		if (!this.refs.has(ref)) throw new BrowserStaleRefError(ref)
		const locator = locateRef(tab.page, ref)
		let count = 0
		try {
			count = await locator.count()
		} catch {
			count = 0
		}
		if (count !== 1) throw new BrowserStaleRefError(ref)
		return locator
	}

	private async screenshot(ref?: string, fullPage?: boolean): Promise<BrowserResult> {
		const tab = await this.activeTab()
		if (this.pendingDialog?.tab === tab) {
			throw new Error(
				'A dialog is open; dismiss it with browser_act dialog before taking a screenshot.',
			)
		}
		// Screenshots are image blocks sent to the model. Mask the fields that
		// take a password or a one-time code, in every frame; the other inputs
		// stay visible, because a search box or an address field the model
		// cannot read cannot be checked. Closed shadow roots and page-drawn
		// text remain outside this mask.
		const mask = await this.credentialMask(tab)
		const data =
			ref !== undefined
				? await (await this.resolveRef(tab, ref)).screenshot({
						type: 'png',
						mask,
						maskColor: SCREENSHOT_INPUT_MASK_COLOR,
					})
				: await tab.page.screenshot({
						type: 'png',
						fullPage: fullPage === true,
						mask,
						maskColor: SCREENSHOT_INPUT_MASK_COLOR,
					})
		const bytes = new Uint8Array(data)
		const size = pngSize(bytes)
		return this.result({
			screenshot: {
				page: await this.pageInfo(tab),
				data: bytes,
				mimeType: 'image/png',
				width: size.width,
				height: size.height,
			},
		})
	}

	/** Locators of the credential fields (password, one-time code) of every frame of the tab. */
	private async credentialMask(tab: Tab): Promise<Locator[]> {
		const out: Locator[] = []
		for (const frame of tab.page.frames()) {
			const inputs = frame.locator('input, textarea')
			let count = 0
			try {
				count = Math.min(await inputs.count(), MASK_CANDIDATES_MAX)
			} catch {
				// A frame that went away while we looked has nothing to mask.
				continue
			}
			const verdicts = await Promise.all(
				Array.from({ length: count }, async (_, index) => {
					try {
						return isCredentialField(
							await inputs.nth(index).evaluate(fieldFacts, undefined, { timeout: 2000 }),
						)
					} catch {
						// A field that cannot be asked about is hidden to be safe.
						return true
					}
				}),
			)
			verdicts.forEach((hide, index) => {
				if (hide) out.push(inputs.nth(index))
			})
		}
		return out
	}

	/** One element's current value and state, read from the page itself. */
	private async readValue(ref: string): Promise<BrowserResult> {
		const tab = await this.activeTab()
		if (this.pendingDialog?.tab === tab) {
			throw new Error(
				'A dialog is open; dismiss it with browser_act dialog before reading a value.',
			)
		}
		const locator = await this.resolveRef(tab, ref)
		const facts = await locator.evaluate(fieldFacts)
		const described = this.refs.get(ref)
		const page = await this.pageInfo(tab)
		const hidden = isCredentialField(facts)
		const read = hidden ? undefined : await locator.evaluate(valueFacts)
		const value: BrowserValue = {
			page,
			ref,
			...(described?.role !== undefined ? { role: described.role } : {}),
			...(described?.name !== undefined ? { name: described.name } : {}),
			...(read?.value !== undefined ? { value: read.value } : {}),
			state: read?.state ?? [],
			...(read?.options !== undefined ? { options: read.options } : {}),
			...(hidden ? { hidden: true } : {}),
		}
		return this.result({ value })
	}

	private async scroll(
		direction: 'up' | 'down' | 'left' | 'right',
		ref?: string,
		amount?: number,
	): Promise<BrowserResult> {
		const tab = await this.activeTab()
		const screens = amount ?? 1
		const vector = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[direction]
		const [dx, dy] = vector as [number, number]
		if (ref !== undefined) {
			const locator = await this.resolveRef(tab, ref)
			await locator.evaluate(
				(el, [x, y, n]) => {
					el.scrollBy({
						left: x * el.clientWidth * 0.9 * n,
						top: y * el.clientHeight * 0.9 * n,
					})
				},
				[dx, dy, screens] as const,
			)
		} else {
			await tab.page.evaluate(
				([x, y, n]) => {
					window.scrollBy({
						left: x * window.innerWidth * 0.9 * n,
						top: y * window.innerHeight * 0.9 * n,
					})
				},
				[dx, dy, screens] as const,
			)
		}
		this.notes.unshift(`Scrolled ${direction}.`)
		return this.result({ page: await this.pageInfo(tab) })
	}

	private async waitFor(
		action: Extract<BrowserObserveAction, { action: 'wait_for' }>,
	): Promise<BrowserResult> {
		const tab = await this.activeTab()
		const timeout = Math.min(action.timeMs ?? 30_000, 30_000)
		if (this.pendingDialog?.tab === tab) {
			return this.result({ page: await this.pageInfo(tab) })
		}
		if (action.text !== undefined || action.textGone !== undefined) {
			const text = (action.text ?? action.textGone) as string
			const state = action.text !== undefined ? 'visible' : 'hidden'
			try {
				await tab.page.getByText(text).first().waitFor({ state, timeout })
				this.notes.unshift(
					action.text !== undefined
						? `${quoteShort(text)} is on the page.`
						: `${quoteShort(text)} is gone.`,
				)
			} catch {
				this.notes.unshift(
					action.text !== undefined
						? `${quoteShort(text)} did not appear within ${timeout} ms.`
						: `${quoteShort(text)} was still there after ${timeout} ms.`,
				)
			}
		} else if (action.stable !== true) {
			await tab.page.waitForTimeout(timeout)
			this.notes.unshift(`Waited ${timeout} ms.`)
		}
		if (action.stable === true) {
			const cap = action.timeMs !== undefined ? timeout : STABLE_DEFAULT_WAIT_MS
			const settled = await this.settle(tab, { quietMs: QUIET_MS, capMs: cap })
			this.notes.push(
				settled.quiet
					? `The page is quiet (nothing changed for ${QUIET_MS} ms; waited ${settled.waitedMs} ms).`
					: `The page was still changing after ${settled.waitedMs} ms.`,
			)
		}
		return this.result({ page: await this.pageInfo(tab) })
	}

	private async tabsCall(
		action: Extract<BrowserObserveAction, { action: 'tabs' }>,
	): Promise<BrowserResult> {
		const context = await this.ensureContext()
		await this.activeTab()
		switch (action.op) {
			case 'list':
				return this.result({ tabs: await this.tabList() })
			case 'select': {
				const tab = this.tabs.get(action.tab ?? '')
				if (!tab) throw new Error(`There is no tab ${action.tab}. List the tabs to see their ids.`)
				this.activeTabId = tab.id
				await tab.page.bringToFront().catch(() => undefined)
				this.refs = new Map()
				return this.result({ page: await this.pageInfo(tab) })
			}
			case 'close': {
				const tab = this.tabs.get(action.tab ?? '')
				if (!tab) throw new Error(`There is no tab ${action.tab}. List the tabs to see their ids.`)
				await tab.page.close().catch(() => undefined)
				this.tabs.delete(tab.id)
				if (this.activeTabId === tab.id) {
					this.activeTabId = [...this.tabs.keys()].pop()
					this.refs = new Map()
				}
				return this.result({ tabs: await this.tabList() })
			}
			case 'new': {
				const page = await this.openOwnPage(context)
				const tab = this.adopt(page, false)
				this.activeTabId = tab.id
				this.refs = new Map()
				if (action.url === undefined || action.url === 'about:blank') {
					return this.result({ page: await this.pageInfo(tab) })
				}
				return this.navigate(tab, action.url)
			}
		}
	}

	private async tabList(): Promise<BrowserTabInfo[]> {
		const out: BrowserTabInfo[] = []
		for (const tab of this.tabs.values()) {
			if (tab.page.isClosed()) continue
			out.push({
				...(await this.pageInfo(tab)),
				active: tab.id === this.activeTabId,
			})
		}
		return out
	}

	// -------------------------------------------------------------------------
	// Acting
	// -------------------------------------------------------------------------

	private async guardField(locator: Probe): Promise<ElementFieldFacts> {
		const facts = await evaluateOn(locator, fieldFacts)
		if (isCredentialField(facts)) {
			throw new Error(
				'This action targets a password or one-time-code control. Ask the operator to use the browser window.',
			)
		}
		return facts
	}

	/** Refuse direct form submission while a form holds a password or code input. */
	private async guardCredentialForm(
		locator: Probe,
		action: 'click' | 'press' | 'type-submit',
		key?: string,
	): Promise<void> {
		const context = await evaluateOn(locator, (element) => {
			const label = element.closest('label') as HTMLLabelElement | null
			const labelledField = label?.control
				? {
						tag: label.control.tagName.toLowerCase(),
						type: label.control instanceof HTMLInputElement ? label.control.type.toLowerCase() : '',
						autocomplete: label.control.getAttribute('autocomplete') ?? '',
						name: label.control.getAttribute('name') ?? '',
						id: label.control.id,
						label: label.textContent ?? '',
					}
				: undefined
			const button = element.closest('button, input[type="submit"], input[type="image"]')
			const associated = (button ?? element) as HTMLInputElement
			const form = associated.form ?? element.closest('form')
			const fields = form
				? Array.from(form.elements)
						.filter(
							(field) => field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement,
						)
						.map((field) => ({
							tag: field.tagName.toLowerCase(),
							type: field instanceof HTMLInputElement ? field.type.toLowerCase() : '',
							autocomplete: field.getAttribute('autocomplete') ?? '',
							name: field.getAttribute('name') ?? '',
							id: field.id,
							label: [
								field.getAttribute('aria-label') ?? '',
								field.getAttribute('placeholder') ?? '',
								...Array.from((field as HTMLInputElement).labels ?? []).map(
									(label) => label.textContent ?? '',
								),
							].join(' '),
						}))
				: []
			return { isFormButton: button !== null, labelledField, fields }
		})
		if (context.labelledField && isCredentialField(context.labelledField)) {
			throw new Error('This action targets a password or one-time-code control.')
		}
		if (!context.fields.some(isCredentialField)) return
		if (
			(action === 'click' && context.isFormButton) ||
			(action === 'press' && (context.isFormButton || /enter|return/i.test(key ?? ''))) ||
			action === 'type-submit'
		) {
			throw new Error(
				'This action could submit a form containing a password or one-time-code control. Ask the operator to use the browser window.',
			)
		}
	}

	/**
	 * The page's tree as the model could have read it just before an action,
	 * or `undefined` when it cannot be read now (a dialog holds the page, or
	 * the read failed). An effect is a bonus; it never fails the action.
	 */
	private async effectBaseline(tab: Tab): Promise<string | undefined> {
		if (this.pendingDialog?.tab === tab) return undefined
		try {
			return (await this.readTree(tab)).whole.text
		} catch {
			return undefined
		}
	}

	/** What the action did, from the tree before and the tree now. */
	private async effectSince(
		before: string | undefined,
		urlBefore: string,
		tabsBefore: number,
		tab: Tab,
		settled: SettleOutcome,
	): Promise<BrowserEffect | undefined> {
		if (before === undefined || this.pendingDialog?.tab === tab || tab.page.isClosed())
			return undefined
		let after: string
		try {
			after = (await this.readTree(tab)).whole.text
		} catch {
			return undefined
		}
		return buildEffect(
			{
				beforeTree: before,
				afterTree: after,
				urlBefore,
				urlNow: tab.page.url(),
				tabsBefore,
				tabsNow: this.tabs.size,
				settle: { quiet: settled.quiet, waitedMs: settled.waitedMs, capMs: settled.capMs },
			},
			EFFECT_LINES_SHOWN,
		)
	}

	private async runAct(action: BrowserActAction): Promise<BrowserResult> {
		const tab = await this.activeTab()
		await this.settle(tab, { quietMs: PRE_ACT_QUIET_MS, capMs: PRE_ACT_CAP_MS })
		const expected = canonicalizeBrowserOrigin(action.origin)
		const live = originOf(tab.page.url())
		if (!expected.ok || expected.origin !== live) {
			// The page moved since the snapshot. Going on is fine only when the
			// site rules treat the new origin exactly as the named one: both at
			// `act`, where no review stood between the model and the page.
			const sameRules =
				expected.ok &&
				live !== 'null' &&
				this.policy.levelOf(expected.origin) === 'act' &&
				this.policy.levelOf(live) === 'act'
			if (!sameRules) {
				throw new BrowserOriginMismatchError(
					expected.ok ? expected.origin : action.origin,
					live === 'null' ? 'about:blank' : live,
				)
			}
			this.notes.unshift(
				`The page is now at ${live}, not ${expected.origin}; the site rules treat both alike, so the action went ahead there.`,
			)
		}
		if (!this.policy.canAct(live)) {
			throw new BrowserSiteDeniedError(
				live,
				`${live} may be read but not changed under the site rules.`,
			)
		}
		if (action.action === 'dialog') return this.answerDialog(tab, action)
		if (this.pendingDialog?.tab === tab) {
			throw new Error('A dialog is open on this tab; dismiss it with browser_act dialog first.')
		}
		const checkpoint = await this.beginDocumentResponseChange(tab)
		const urlBefore = tab.page.url()
		const tabsBefore = this.tabs.size
		const treeBefore = await this.effectBaseline(tab)
		let settled: SettleOutcome
		try {
			await this.perform(tab, action)
			settled = await this.settle(tab)
			this.checkLanding(tab)
			while (this.blanking.size > 0) await Promise.all([...this.blanking])
		} catch (error) {
			await this.finishDocumentResponseChange(tab, checkpoint).catch(() => undefined)
			throw error
		}
		await this.finishDocumentResponseChange(tab, checkpoint)
		await this.checkHuman(tab)
		const after = this.tabs.get(tab.id) ?? tab
		const effect = await this.effectSince(treeBefore, urlBefore, tabsBefore, after, settled)
		if (action.snapshot) {
			return this.result({
				snapshot: await this.takeSnapshot(after),
				...(effect ? { effect } : {}),
			})
		}
		return this.result({ page: await this.pageInfo(after), ...(effect ? { effect } : {}) })
	}

	private async answerDialog(
		tab: Tab,
		action: Extract<BrowserActAction, { action: 'dialog' }>,
	): Promise<BrowserResult> {
		const pending = this.pendingDialog
		if (!pending || pending.tab !== tab) throw new Error('No dialog is open on this tab.')
		if (action.accept) {
			throw new Error(
				'The agent cannot accept a page-created dialog. Dismiss it, or ask the operator to use the browser window.',
			)
		}
		this.pendingDialog = undefined
		const checkpoint = pending.checkpoint ?? {
			previous: this.documentResponse(tab),
			responsesBefore: tab.mainDocumentResponses,
			commitsBefore: tab.mainFrameCommits,
		}
		this.clearDocumentResponse(tab)
		try {
			await pending.dialog.dismiss()
		} catch (error) {
			this.setDocumentResponse(tab, checkpoint.previous)
			throw new BrowserOutcomeUnknownError('dialog', error)
		}
		this.notes.unshift('The dialog was dismissed.')
		await this.settle(tab)
		this.checkLanding(tab)
		while (this.blanking.size > 0) await Promise.all([...this.blanking])
		await this.finishDocumentResponseChange(tab, checkpoint)
		await this.checkHuman(tab)
		if (action.snapshot) return this.result({ snapshot: await this.takeSnapshot(tab) })
		return this.result({ page: await this.pageInfo(tab) })
	}

	/**
	 * Do the action. Everything that can refuse — refs, credential fields,
	 * actionability — is checked before anything happens; a failure after
	 * the first change is `browser_outcome_unknown`.
	 */
	private async perform(tab: Tab, action: BrowserActAction): Promise<void> {
		switch (action.action) {
			case 'click': {
				const target = await this.reach(tab, action)
				await this.guardField(target.locator)
				await this.guardCredentialForm(target.locator, 'click')
				const at = target.position ? { position: target.position } : {}
				await this.noEffectOnFailure('click', () => target.locator.click({ trial: true, ...at }))
				await this.unknownOnFailure('click', () =>
					action.doubleClick ? target.locator.dblclick(at) : target.locator.click(at),
				)
				return
			}
			case 'hover': {
				const target = await this.reach(tab, action)
				await this.guardField(target.locator)
				const at = target.position ? { position: target.position } : {}
				await this.noEffectOnFailure('hover', () => target.locator.hover({ trial: true, ...at }))
				await this.unknownOnFailure('hover', () => target.locator.hover(at))
				return
			}
			case 'type': {
				const locator = await this.resolveRef(tab, action.ref)
				await this.guardField(locator)
				if (action.submit) await this.guardCredentialForm(locator, 'type-submit')
				await this.noEffectOnFailure('type', () => locator.click({ trial: true }))
				await this.unknownOnFailure('type', async (begun) => {
					if (action.keys) {
						await locator.focus()
						// Clearing and typing change the field; from here a failure is not harmless.
						begun()
						if (action.append) await locator.press('Control+End')
						else await locator.fill('')
						await locator.pressSequentially(action.text, { delay: KEY_DELAY_MS })
					} else if (action.append) {
						const held = await locator
							.inputValue()
							.catch(() => locator.evaluate((el) => el.textContent ?? ''))
						await locator.fill(held + action.text)
					} else {
						await locator.fill(action.text)
					}
					if (action.submit) await locator.press('Enter')
				})
				return
			}
			case 'fill_form': {
				const plan: {
					locator: Locator
					facts: ElementFieldFacts
					value: string
				}[] = []
				for (const field of action.fields) {
					const locator = await this.resolveRef(tab, field.ref)
					const facts = await this.guardField(locator)
					if (facts.kind === 'file') {
						throw new Error(`${field.ref} is a file input; use browser_act upload for it.`)
					}
					plan.push({ locator, facts, value: field.value })
				}
				await this.unknownOnFailure('fill_form', async () => {
					for (const step of plan) {
						if (step.facts.kind === 'checkbox' || step.facts.kind === 'radio') {
							await step.locator.setChecked(step.value === 'true')
						} else if (step.facts.kind === 'select') {
							await step.locator
								.selectOption([{ label: step.value }])
								.catch(() => step.locator.selectOption(step.value))
						} else {
							await step.locator.fill(step.value)
						}
					}
				})
				return
			}
			case 'select': {
				const locator = await this.resolveRef(tab, action.ref)
				await this.unknownOnFailure('select', () => locator.selectOption([...action.values]))
				return
			}
			case 'press': {
				if (action.ref !== undefined) {
					const locator = await this.resolveRef(tab, action.ref)
					await this.guardField(locator)
					await this.guardCredentialForm(locator, 'press', action.key)
					await this.unknownOnFailure('press', () => locator.press(action.key))
					return
				}
				const key = namedKey(action.key)
				if (!key) {
					throw new Error(
						`Without a ref, press takes only ${NAMED_KEYS.join(', ')}. Any other key goes to a specific control: give its ref.`,
					)
				}
				await this.guardFocus(tab, key)
				await this.unknownOnFailure('press', () => tab.page.keyboard.press(key))
				return
			}
			case 'upload': {
				const locator = await this.resolveRef(tab, action.ref)
				await this.guardField(locator)
				const facts = await locator.evaluate(fieldFacts)
				if (facts.kind === 'file') {
					await this.unknownOnFailure('upload', () => locator.setInputFiles(action.path))
					return
				}
				await this.guardCredentialForm(locator, 'click')
				await locator.click({ trial: true })
				await this.unknownOnFailure('upload', async () => {
					const [chooser] = await Promise.all([
						tab.page.waitForEvent('filechooser'),
						locator.click(),
					])
					await chooser.setFiles(action.path)
				})
				return
			}
			case 'dialog':
				return
		}
	}

	/**
	 * The element a click or hover means, and where on it to aim. A ref names
	 * it directly; a role with a name, or visible text, is looked up and
	 * refused unless exactly one element matches. A container (a section, a
	 * list item holding a menu title) is not clicked in its middle, which is
	 * often empty: the aim goes to its first control or to its own text.
	 */
	private async reach(
		tab: Tab,
		target: BrowserTarget,
	): Promise<{ locator: Locator; position?: { x: number; y: number } }> {
		const found =
			target.ref !== undefined
				? await this.resolveRef(tab, target.ref)
				: await this.findTarget(tab, target)
		let aim: Aim = { kind: 'centre' }
		try {
			aim = await found.evaluate(aimInside)
		} catch {
			// Aim at the middle, as before.
		}
		if (aim.kind === 'descendant') return { locator: found.locator(`xpath=${aim.path}`) }
		if (aim.kind === 'text') return { locator: found, position: { x: aim.x, y: aim.y } }
		return { locator: found }
	}

	/** Find the one element a role/name or text target means, or refuse with the candidates. */
	private async findTarget(tab: Tab, target: BrowserTarget): Promise<Locator> {
		const page = tab.page
		const role = target.role
		const wanted =
			role !== undefined ? `${role} "${target.name ?? ''}"` : `text "${target.text ?? ''}"`
		const build = (exact: boolean): Locator =>
			role !== undefined
				? page.getByRole(role as Parameters<Page['getByRole']>[0], {
						name: target.name ?? '',
						exact,
					})
				: page.getByText(target.text ?? '', { exact }).filter({ visible: true })
		let locator = build(false)
		let count = await locator.count()
		if (count > 1) {
			// A short name also fits longer ones ("Save" in "Save draft"): the exact matches decide.
			const exact = build(true)
			const exactCount = await exact.count()
			if (exactCount > 0) {
				locator = exact
				count = exactCount
			}
		}
		if (count === 1) return locator
		const pool =
			count > 0 ? locator : role !== undefined ? page.getByRole(role as never) : undefined
		const candidates = []
		if (pool) {
			const total = Math.min(await pool.count(), CANDIDATES_MAX)
			for (let i = 0; i < total; i++) {
				candidates.push(await pool.nth(i).evaluate(describeCandidate))
			}
		}
		throw new BrowserTargetUnclearError(wanted, count, candidates)
	}

	/**
	 * Refuse a key sent to the page when the focus is on a credential, or
	 * when it cannot be told. Every frame is asked, because the key goes to
	 * whichever one holds the focus and a stale focus in another frame is
	 * still a reason to be careful.
	 */
	private async guardFocus(tab: Tab, key: NamedKey): Promise<void> {
		for (const frame of tab.page.frames()) {
			const handle = await frame.evaluateHandle(deepFocus).catch(() => undefined)
			const element = handle?.asElement() ?? null
			if (!element) continue
			if (keyCanCommit(key) && (await element.evaluate(focusIsOpaque))) {
				throw new Error(
					`The focus is on a component whose inside cannot be read, so ${key} could reach a password or code field. Use browser_act with the ref of a specific control.`,
				)
			}
			await this.guardField(element)
			await this.guardCredentialForm(element, 'press', key)
		}
	}

	/** A check Playwright runs without acting (`trial`) failed: nothing on the page changed. */
	private async noEffectOnFailure(
		action: BrowserActAction['action'],
		run: () => Promise<unknown>,
	): Promise<void> {
		try {
			await run()
		} catch (error) {
			throw new BrowserNoEffectError(action, noEffectReason(error))
		}
	}

	/**
	 * Run the change. A failure once it has started is `outcome unknown`. A
	 * dialog the action opens ends the wait: the page is paused until the
	 * dialog is answered, and so is anything Playwright was still waiting for.
	 */
	private async unknownOnFailure(
		action: BrowserActAction['action'],
		run: (begun: () => void) => Promise<unknown>,
	): Promise<void> {
		let touched = false
		const running = run(() => {
			touched = true
		})
		let timer: ReturnType<typeof setInterval> | undefined
		const dialogOpened = new Promise<'dialog'>((resolve) => {
			timer = setInterval(() => {
				if (this.pendingDialog) resolve('dialog')
			}, 50)
		})
		try {
			const outcome = await Promise.race([running, dialogOpened])
			if (outcome === 'dialog') running.catch(() => undefined)
		} catch (error) {
			// A timeout whose log never reached the input step left the page alone.
			throw !touched && failedBeforeActing(error)
				? new BrowserNoEffectError(action, noEffectReason(error))
				: new BrowserOutcomeUnknownError(action, error)
		} finally {
			clearInterval(timer)
		}
	}

	// -------------------------------------------------------------------------
	// Labels
	// -------------------------------------------------------------------------

	describeRef(ref: string): BrowserRefDescription | undefined {
		return this.refs.get(ref)
	}

	session(): BrowserSessionInfo {
		const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
		const origin = tab && !tab.page.isClosed() ? originOf(tab.page.url()) : 'null'
		return { profile: this.profile, ...(origin !== 'null' ? { origin } : {}) }
	}
}
