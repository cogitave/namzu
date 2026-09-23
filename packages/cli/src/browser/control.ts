/**
 * The interactive session's browser: one `BrowserHost` the tools are built
 * over, whose profile the operator can switch without rebuilding them.
 *
 * `createBrowserTools(host)` reads `host` on every call, so the host handed
 * to it here is a delegate over the real `PlaywrightBrowserHost`. Switching
 * profile (`/browser profile <name>`) disposes the current host (which
 * closes its browser, unless `keepOpen`) and builds the next one; neither
 * launches anything until the model's first browser call.
 *
 * Constructing a `PlaywrightBrowserHost` detects the engine (file probes and
 * `wslinfo`, a few milliseconds) and starts nothing, which is why the
 * session can build one at boot.
 */

import type {
	BrowserEngineSetting,
	BrowserHeadlessSetting,
	PlaywrightBrowserHost,
	PlaywrightBrowserHostOptions,
} from '@namzu/browser'
import type {
	BrowserActAction,
	BrowserCallOptions,
	BrowserCapabilities,
	BrowserHost,
	BrowserObserveAction,
	BrowserRefDescription,
	BrowserResult,
	BrowserSessionInfo,
} from '@namzu/sdk'

import type { BrowserSitesConfig } from '../permissions/browser-sites.js'

/** `@namzu/browser` profile names, restated so this file needs no runtime import to check one. */
export const BROWSER_PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isBrowserProfileName(name: string): boolean {
	return name.length <= 64 && BROWSER_PROFILE_NAME_PATTERN.test(name)
}

/** What the TUI asks the session for. */
export interface BrowserSessionOptions {
	/** Default `default`. */
	readonly profile?: string
	readonly engine?: BrowserEngineSetting
	readonly headless?: BrowserHeadlessSetting
	/** Canonical site rules, `*` included; the host checks landings against them. */
	readonly sites?: BrowserSitesConfig
	readonly keepOpen?: boolean
	/** `NAMZU_HOME`. */
	readonly home?: string
}

/** What `/browser` shows, and what the handoff notice needs. */
export interface BrowserStatus {
	readonly profile: string
	/** `windows-cdp`, `local-chrome`, `local-chromium`, … */
	readonly engine: string
	/** `chrome`, `msedge` or `chromium`. */
	readonly browser: string
	readonly headless: boolean
	readonly running: boolean
	readonly unavailableReason?: string
	readonly warnings: readonly string[]
	readonly sites: BrowserSitesConfig
	readonly keepOpen: boolean
}

export interface BrowserControl {
	/** The host the tools are built over. */
	readonly host: BrowserHost
	status(): BrowserStatus
	/** Run under another profile from the next browser call on. Closes the current browser. */
	switchProfile(name: string): Promise<BrowserStatus>
	/**
	 * Close the browser and release the profile, keeping everything else; the
	 * next call starts it again. For a sign-in in another process
	 * (`namzu browser login`) while this session waits.
	 */
	release(): Promise<void>
	dispose(): Promise<void>
}

type HostConstructor = new (options: PlaywrightBrowserHostOptions) => PlaywrightBrowserHost

export function createBrowserControl(
	Host: HostConstructor,
	options: BrowserSessionOptions,
): BrowserControl {
	const sites = options.sites ?? { '*': 'ask' }
	const build = (profile: string) =>
		new Host({
			profile,
			mode: 'interactive',
			sites,
			...(options.engine ? { engine: options.engine } : {}),
			...(options.headless ? { headless: options.headless } : {}),
			...(options.keepOpen ? { keepOpen: true } : {}),
			...(options.home ? { home: options.home } : {}),
		})
	let current = build(options.profile ?? 'default')
	let disposed = false

	const host: BrowserHost = {
		id: 'namzu-browser',
		get capabilities(): BrowserCapabilities {
			return current.capabilities
		},
		observe(
			action: BrowserObserveAction,
			callOptions?: BrowserCallOptions,
		): Promise<BrowserResult> {
			return current.observe(action, callOptions)
		},
		act(action: BrowserActAction, callOptions?: BrowserCallOptions): Promise<BrowserResult> {
			return current.act(action, callOptions)
		},
		describeRef(ref: string): BrowserRefDescription | undefined {
			return current.describeRef(ref)
		},
		session(): BrowserSessionInfo {
			return current.session()
		},
		async initialize() {
			// Nothing: the browser starts on the first call that needs it.
		},
		async dispose() {
			await control.dispose()
		},
	}

	const control: BrowserControl = {
		host,
		status(): BrowserStatus {
			const plan = current.plan
			return {
				profile: current.profile,
				engine: current.capabilities.engine,
				browser: plan.browser,
				headless: current.capabilities.headless,
				running: current.running,
				...(current.capabilities.unavailableReason !== undefined
					? { unavailableReason: current.capabilities.unavailableReason }
					: {}),
				warnings: current.warnings,
				sites,
				keepOpen: options.keepOpen === true,
			}
		},
		async switchProfile(name: string): Promise<BrowserStatus> {
			if (!isBrowserProfileName(name)) {
				throw new Error(
					`"${name}" is not a profile name: use lowercase letters, digits and single hyphens, at most 64 characters.`,
				)
			}
			if (disposed) throw new Error('The browser of this session is closed.')
			const previous = current
			current = build(name)
			await previous.dispose()
			return control.status()
		},
		async release() {
			if (disposed) return
			const previous = current
			current = build(previous.profile)
			await previous.dispose()
		},
		async dispose() {
			if (disposed) return
			disposed = true
			await current.dispose()
		},
	}
	return control
}

/** The status as `/browser` prints it. */
export function describeBrowserStatus(status: BrowserStatus): string {
	const sites = Object.entries(status.sites)
		.map(([site, level]) => `${site} ${level}`)
		.join(' · ')
	const rows = [
		`Browser: ${status.engine} (${status.browser}) · ${status.headless ? 'no window' : 'visible window'} · ${status.running ? 'running' : 'not started'}`,
		`Profile: ${status.profile}${status.keepOpen ? ' · stays open after the session' : ''}`,
		`Sites: ${sites}`,
		...(status.unavailableReason ? [`Unavailable: ${status.unavailableReason}`] : []),
		...status.warnings.map((warning) => `Note: ${warning}`),
		'Sign in once with `namzu browser login <profile> <url>`; switch with /browser profile <name>.',
	]
	return rows.join('\n')
}
