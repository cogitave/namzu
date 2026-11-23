import type { BrowserContext } from 'playwright-core'
import type { LocalBrowserPlan, WindowsCdpBrowserPlan } from './detect.js'
import { BrowserUnavailableError, ProfileBusyError } from './errors.js'
import {
	type BrowserLease,
	BrowserLeaseStore,
	BrowserProfileError,
	BrowserProfileStore,
} from './profiles.js'
import { PLAYWRIGHT_CORE_VERSION } from './snapshot.js'
import { WindowsBridgeError } from './windows-bridge.js'
import { type WindowsBrowserConnection, connectWindowsBrowser } from './windows-engine.js'

/**
 * Where the host's one {@link BrowserContext} comes from. The host drives a
 * context the same way whatever opened it; a provider is only the opening,
 * and the closing that goes with it.
 */
export interface BrowserContextProvider {
	/** Short name, used in the host id: `local`, `windows-cdp`, `pane`. */
	readonly id: string
	/** Open or attach, returning the single default context. */
	open(services?: ProviderServices): Promise<OpenedBrowserContext>
}

/** What stays attached to a context besides the context itself. */
export interface ExternalConnection {
	/** Close the browser, then the connection. */
	close(): Promise<void>
	/** Disconnect and leave the browser running. */
	detach(): Promise<void>
}

export interface OpenedBrowserContext {
	readonly context: BrowserContext
	/**
	 * `route`: the host alone screens requests with `context.route`.
	 * `external`: the embedder enforces landing rules too, so a context that
	 * cannot intercept requests is tolerated and the host falls back to the
	 * check after the navigation lands.
	 */
	readonly policy: 'route' | 'external'
	/** The profile lease this context holds, released with the context. */
	readonly lease?: BrowserLease
	/** The connection to a browser that outlives the context (Windows, pane). */
	readonly connection?: ExternalConnection
}

/** What the host offers a provider that is built without it (a pane, made by the app). */
export interface ProviderServices {
	/** A line for the next result the model sees. */
	note(text: string): void
}

/** What a provider needs from the host that owns it. */
export interface ProviderHost {
	readonly profile: string
	readonly sessionId: string
	home(): string
	/** A line for the next result the model sees. */
	note(text: string): void
}

export interface LocalProviderOptions {
	readonly plan: LocalBrowserPlan
	readonly executablePath?: string
}

export function firstLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)
	return (text.split('\n')[0] ?? '').slice(0, 300)
}

/** Playwright's own Chromium (or an installed Chrome or Edge) on a persistent profile. */
export class LocalProvider implements BrowserContextProvider {
	readonly id = 'local'

	constructor(
		private readonly host: ProviderHost,
		private readonly options: LocalProviderOptions,
	) {}

	async open(): Promise<OpenedBrowserContext> {
		const { plan } = this.options
		const home = this.host.home()
		const profiles = new BrowserProfileStore(home)
		const descriptor = profiles.ensureLocal(this.host.profile, plan.browser)
		const lease = new BrowserLeaseStore(home).acquire(this.host.profile, this.host.sessionId, {
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
			throw this.launchError(plan, error)
		}
		return { context, policy: 'route', lease }
	}

	private launchError(plan: LocalBrowserPlan, error: unknown): Error {
		const text = error instanceof Error ? error.message : String(error)
		if (
			/Executable doesn't exist|executable doesn't exist|browserType\.launch.*not found/i.test(text)
		) {
			const which =
				plan.browser !== 'chromium'
					? `The installed ${plan.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} was not found where it should be.`
					: `Playwright's Chromium for playwright-core ${PLAYWRIGHT_CORE_VERSION} is not installed.`
			return new BrowserUnavailableError(
				`${which} Run \`namzu browser install\` (or \`npx playwright-core@${PLAYWRIGHT_CORE_VERSION} install chromium\`).`,
			)
		}
		if (/ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(text)) {
			return new ProfileBusyError(this.host.profile, [])
		}
		if (/Missing X server|cannot open display|\$DISPLAY/i.test(text)) {
			return new BrowserUnavailableError(
				'The browser needs a display for a visible window and could not open one. Run headless, or under a desktop session.',
			)
		}
		return new BrowserUnavailableError(`The browser could not start: ${firstLine(error)}`)
	}
}

export interface WindowsCdpProviderOptions {
	readonly plan: WindowsCdpBrowserPlan
	readonly env: NodeJS.ProcessEnv
	readonly keepOpen?: boolean
	readonly windowsLaunchTimeoutMs?: number
}

/**
 * The Windows browser, through the PowerShell bridge. The profile lives on
 * the Windows side; its descriptor here records where. Leases are shared:
 * every namzu process on the profile drives the same browser, and the
 * last one to let go closes it.
 */
export class WindowsCdpProvider implements BrowserContextProvider {
	readonly id = 'windows-cdp'

	constructor(
		private readonly host: ProviderHost,
		private readonly options: WindowsCdpProviderOptions,
	) {}

	async open(): Promise<OpenedBrowserContext> {
		const { plan } = this.options
		const profile = this.host.profile
		const home = this.host.home()
		const profiles = new BrowserProfileStore(home)
		const existing = profiles.get(profile)
		if (existing && existing.engine !== 'windows-cdp') {
			throw new BrowserProfileError(
				`Browser profile "${profile}" belongs to the ${existing.engine} engine, not the Windows browser. Use another profile name.`,
			)
		}
		if (existing && existing.browser !== plan.browser) {
			throw new BrowserProfileError(
				`Browser profile "${profile}" was made with ${existing.browser}, and this run would use ${plan.browser}. Use another profile name, or the browser the profile was made with.`,
			)
		}
		const lease = new BrowserLeaseStore(home).acquire(profile, this.host.sessionId)
		let connection: WindowsBrowserConnection
		try {
			connection = await connectWindowsBrowser({
				plan,
				profile,
				...(existing ? { userDataDir: existing.userDataDir } : {}),
				closeOnExit: !this.options.keepOpen,
				env: this.options.env,
				...(this.options.windowsLaunchTimeoutMs !== undefined
					? { timeoutMs: this.options.windowsLaunchTimeoutMs }
					: {}),
				onDownloadRefused: (name) => {
					this.host.note(
						`A download of ${quoteShort(name)} was cancelled: the browser does not download files.`,
					)
				},
			})
		} catch (error) {
			lease.release()
			throw this.launchError(plan, error)
		}
		try {
			profiles.ensureWindows(profile, plan.browser, connection.userDataDir)
		} catch (error) {
			lease.release()
			await connection.detach().catch(() => undefined)
			throw error
		}
		return { context: connection.context, policy: 'route', lease, connection }
	}

	private launchError(plan: WindowsCdpBrowserPlan, error: unknown): Error {
		const name = plan.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'
		if (error instanceof WindowsBridgeError) {
			if (error.code === 'browser-exited') return new ProfileBusyError(this.host.profile, [])
			return new BrowserUnavailableError(
				`The Windows ${name} could not be started from WSL: ${error.message}`,
			)
		}
		return new BrowserUnavailableError(
			`The Windows ${name} was started but could not be driven from WSL: ${firstLine(error)}`,
		)
	}
}

export function quoteShort(value: string, max = 80): string {
	const flat = value.replace(/\s+/g, ' ').trim()
	return JSON.stringify(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat)
}
