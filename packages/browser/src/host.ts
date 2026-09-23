import { randomBytes } from 'node:crypto'
import type {
	BrowserActAction,
	BrowserCallOptions,
	BrowserCapabilities,
	BrowserHost,
	BrowserObserveAction,
	BrowserPageInfo,
	BrowserRefDescription,
	BrowserResult,
	BrowserSessionInfo,
	BrowserSnapshot,
	BrowserTabInfo,
} from '@namzu/sdk'
import { canonicalizeBrowserOrigin, canonicalizeBrowserUrl, resolveNamzuHome } from '@namzu/sdk'
import {
	type BrowserContext,
	type Dialog,
	type Locator,
	type Page,
	type Route,
	chromium,
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
	BrowserOriginMismatchError,
	BrowserOutcomeUnknownError,
	BrowserSiteDeniedError,
	BrowserStaleRefError,
	BrowserUnavailableError,
	ProfileBusyError,
} from './errors.js'
import {
	type ElementFieldFacts,
	countCredentialFields,
	fieldFacts,
	focusedFieldFacts,
} from './page-scripts.js'
import { BrowserSitePolicy, type BrowserSiteRules, DEFAULT_BROWSER_SITE_RULES } from './policy.js'
import {
	type BrowserLease,
	BrowserLeaseStore,
	BrowserProfileError,
	BrowserProfileStore,
	DEFAULT_BROWSER_PROFILE,
} from './profiles.js'
import {
	PLAYWRIGHT_CORE_VERSION,
	SnapshotPager,
	captureAriaTree,
	locateRef,
	renderAriaTree,
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
	/** HTTP status of the main document's last response. */
	status?: number
}

interface PendingDialog {
	readonly tab: Tab
	readonly dialog: Dialog
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const DEFAULT_ACTION_TIMEOUT_MS = 10_000
const SNAPSHOT_PAGE_MAX = 20_000
/** How long the host lets events (popups, downloads, dialogs) arrive after an action. */
const EVENT_SETTLE_MS = 150
/** Smallest frame that can hold a CAPTCHA a person is meant to solve. */
const CAPTCHA_FRAME_MIN_PX = 30

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

/** Keys that type nothing: allowed while a credential field has focus. */
const NON_TYPING_KEYS = new Set(['Tab', 'Shift+Tab', 'Escape', 'Enter'])

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
 * - a sign-in, second factor, CAPTCHA, bot wall or HTTP credential prompt
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
		for (const page of context.pages()) this.adopt(page, false)
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
		const tab: Tab = { id: `t${this.tabCounter}`, page }
		this.tabs.set(tab.id, tab)
		this.tabOf.set(page, tab)
		if (this.activeTabId === undefined) this.activeTabId = tab.id
		if (announce && !this.ownPageOpening) {
			this.notes.push(
				`The page opened a new tab, ${tab.id}; it is not the active tab. Use tabs list or select to look at it.`,
			)
		}
		page.on('framenavigated', (frame) => {
			if (frame === page.mainFrame()) this.checkLanding(tab)
		})
		page.on('response', (response) => {
			try {
				if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
					tab.status = response.status()
				}
			} catch {
				// A response without a frame (a service worker's) says nothing about the page.
			}
		})
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
			`A ${dialog.type()} dialog is open on tab ${tab.id}. Take a snapshot to read it, then answer it with browser_act dialog.`,
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

	private async settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, EVENT_SETTLE_MS))
		while (this.blanking.size > 0) await Promise.all([...this.blanking])
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
		return { origin: originOf(url), url, title: await this.title(tab), tab: tab.id }
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
				...counts,
				frameUrls,
			},
			this.options.signInAddresses ? { signInAddresses: this.options.signInAddresses } : {},
		)
		if (reason) throw this.humanRequired(reason, tab)
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
				return this.snapshot(action.ref, action.cursor)
			case 'screenshot':
				return this.screenshot(action.ref, action.fullPage)
			case 'scroll':
				return this.scroll(action.direction, action.ref, action.amount)
			case 'wait_for':
				return this.waitFor(action)
			case 'tabs':
				return this.tabsCall(action)
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
		tab.status = undefined
		try {
			await tab.page.goto(verdict.url, { waitUntil: 'domcontentloaded' })
		} catch (error) {
			if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|Download is starting/.test(firstLine(error))) {
				throw new Error(`Could not open ${verdict.url}: ${firstLine(error)}`)
			}
		}
		return this.afterNavigation(tab)
	}

	private async afterNavigation(tab: Tab): Promise<BrowserResult> {
		await this.settle()
		this.checkLanding(tab)
		await this.settle()
		await this.checkHuman(tab)
		return this.result({ page: await this.pageInfo(tab) })
	}

	private async history(which: 'back' | 'forward' | 'reload'): Promise<BrowserResult> {
		const tab = await this.activeTab()
		await this.dismissPendingDialog(tab)
		tab.status = undefined
		const options = { waitUntil: 'domcontentloaded' as const }
		let response: unknown = true
		try {
			response =
				which === 'back'
					? await tab.page.goBack(options)
					: which === 'forward'
						? await tab.page.goForward(options)
						: await tab.page.reload(options)
		} catch (error) {
			if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(firstLine(error))) throw error
		}
		if (response === null && which !== 'reload') {
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

	private async takeSnapshot(tab: Tab, ref?: string): Promise<BrowserSnapshot> {
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
		const { nodes, hidden, redact } = await captureAriaTree(
			tab.page,
			this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
		)
		const whole = renderAriaTree(nodes, hidden, undefined, redact)
		if (!whole) throw new Error('The page could not be read.')
		this.refs = whole.refs
		let text = whole.text
		if (ref !== undefined) {
			const region = renderAriaTree(nodes, hidden, ref, redact)
			if (!region || !whole.refs.has(ref)) throw new BrowserStaleRefError(ref)
			text = region.text
		}
		if (text.trim() === '') text = '(nothing readable on this page)'
		const first = this.pager.start(text)
		return {
			page: await this.pageInfo(tab),
			text: first.text,
			...(first.nextCursor !== undefined ? { nextCursor: first.nextCursor } : {}),
		}
	}

	private async snapshot(ref?: string, cursor?: string): Promise<BrowserResult> {
		const tab = await this.activeTab()
		if (cursor !== undefined) {
			const next = this.pager.resume(cursor)
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
		await this.settle()
		return this.result({ snapshot: await this.takeSnapshot(tab, ref) })
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
				'A dialog is open; answer it with browser_act dialog before taking a screenshot.',
			)
		}
		const data =
			ref !== undefined
				? await (await this.resolveRef(tab, ref)).screenshot({ type: 'png' })
				: await tab.page.screenshot({ type: 'png', fullPage: fullPage === true })
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
		} else {
			await tab.page.waitForTimeout(timeout)
			this.notes.unshift(`Waited ${timeout} ms.`)
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
			out.push({ ...(await this.pageInfo(tab)), active: tab.id === this.activeTabId })
		}
		return out
	}

	// -------------------------------------------------------------------------
	// Acting
	// -------------------------------------------------------------------------

	private async guardField(tab: Tab, locator: Locator): Promise<ElementFieldFacts> {
		const facts = await locator.evaluate(fieldFacts)
		if (isCredentialField(facts)) throw this.humanRequired('credential-field', tab)
		return facts
	}

	private async runAct(action: BrowserActAction): Promise<BrowserResult> {
		const tab = await this.activeTab()
		await this.settle()
		const expected = canonicalizeBrowserOrigin(action.origin)
		const live = originOf(tab.page.url())
		if (!expected.ok || expected.origin !== live) {
			throw new BrowserOriginMismatchError(
				expected.ok ? expected.origin : action.origin,
				live === 'null' ? 'about:blank' : live,
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
			throw new Error('A dialog is open on this tab; answer it with browser_act dialog first.')
		}

		await this.perform(tab, action)
		await this.settle()
		this.checkLanding(tab)
		await this.settle()
		await this.checkHuman(tab)
		const after = this.tabs.get(tab.id) ?? tab
		if (action.snapshot) return this.result({ snapshot: await this.takeSnapshot(after) })
		return this.result({ page: await this.pageInfo(after) })
	}

	private async answerDialog(
		tab: Tab,
		action: Extract<BrowserActAction, { action: 'dialog' }>,
	): Promise<BrowserResult> {
		const pending = this.pendingDialog
		if (!pending || pending.tab !== tab) throw new Error('No dialog is open on this tab.')
		this.pendingDialog = undefined
		try {
			if (action.accept) await pending.dialog.accept(action.promptText)
			else await pending.dialog.dismiss()
		} catch (error) {
			throw new BrowserOutcomeUnknownError('dialog', error)
		}
		this.notes.unshift(action.accept ? 'The dialog was accepted.' : 'The dialog was dismissed.')
		await this.settle()
		this.checkLanding(tab)
		await this.settle()
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
				const locator = await this.resolveRef(tab, action.ref)
				await locator.click({ trial: true })
				await this.unknownOnFailure('click', () =>
					action.doubleClick ? locator.dblclick() : locator.click(),
				)
				return
			}
			case 'hover': {
				const locator = await this.resolveRef(tab, action.ref)
				await locator.hover({ trial: true })
				await this.unknownOnFailure('hover', () => locator.hover())
				return
			}
			case 'type': {
				const locator = await this.resolveRef(tab, action.ref)
				await this.guardField(tab, locator)
				await locator.click({ trial: true })
				await this.unknownOnFailure('type', async () => {
					await locator.fill(action.text)
					if (action.submit) await locator.press('Enter')
				})
				return
			}
			case 'fill_form': {
				const plan: { locator: Locator; facts: ElementFieldFacts; value: string }[] = []
				for (const field of action.fields) {
					const locator = await this.resolveRef(tab, field.ref)
					const facts = await this.guardField(tab, locator)
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
					const facts = await locator.evaluate(fieldFacts)
					if (isCredentialField(facts) && !NON_TYPING_KEYS.has(action.key)) {
						throw this.humanRequired('credential-field', tab)
					}
					await this.unknownOnFailure('press', () => locator.press(action.key))
					return
				}
				const focused = await tab.page.evaluate(focusedFieldFacts).catch(() => null)
				if (focused && isCredentialField(focused) && !NON_TYPING_KEYS.has(action.key)) {
					throw this.humanRequired('credential-field', tab)
				}
				await this.unknownOnFailure('press', () => tab.page.keyboard.press(action.key))
				return
			}
			case 'upload': {
				const locator = await this.resolveRef(tab, action.ref)
				const facts = await locator.evaluate(fieldFacts)
				if (facts.kind === 'file') {
					await this.unknownOnFailure('upload', () => locator.setInputFiles(action.path))
					return
				}
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
	 * Run the change. A failure once it has started is `outcome unknown`. A
	 * dialog the action opens ends the wait: the page is paused until the
	 * dialog is answered, and so is anything Playwright was still waiting for.
	 */
	private async unknownOnFailure(
		action: BrowserActAction['action'],
		run: () => Promise<unknown>,
	): Promise<void> {
		const running = run()
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
			throw new BrowserOutcomeUnknownError(action, error)
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
