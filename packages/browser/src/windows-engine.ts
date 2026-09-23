import { type Browser, type BrowserContext, type CDPSession, chromium } from 'playwright-core'
import type { WindowsCdpBrowserPlan } from './detect.js'
import { type CdpRelay, startCdpRelay } from './relay.js'
import { type StartWindowsBridgeOptions, WindowsCdpBridge } from './windows-bridge.js'

/**
 * The `windows-cdp` engine: the Windows browser, started (or found) by the
 * PowerShell bridge, driven by Playwright over CDP.
 *
 * Under NAT networking, WSL cannot reach Windows' `127.0.0.1`, so Playwright
 * connects to a relay on WSL's `127.0.0.1` and every message crosses the
 * bridge's standard streams. Under mirrored networking it first tries the
 * browser's own port, and falls back to the relay when that does not answer.
 * Either way the bridge process stays up: it is what closes a browser it
 * started if this process dies.
 */

export interface WindowsBrowserConnection {
	readonly browser: Browser
	readonly context: BrowserContext
	readonly bridge: WindowsCdpBridge
	/** `relay` through the bridge, or `direct` to the browser's port (mirrored networking). */
	readonly transport: 'relay' | 'direct'
	/** The profile's user data directory, as Windows sees it. */
	readonly userDataDir: string
	/** Whether the bridge started the browser (else it attached to one already running). */
	readonly launched: boolean
	/** Close the browser, then the connection. */
	close(): Promise<void>
	/** Disconnect and leave the browser running. */
	detach(): Promise<void>
}

export interface ConnectWindowsBrowserOptions {
	readonly plan: WindowsCdpBrowserPlan
	readonly profile: string
	/** The profile's user data directory (Windows path) when it is already known. */
	readonly userDataDir?: string
	/** Close a browser the bridge started if this process goes away. */
	readonly closeOnExit: boolean
	/** The environment `powershell.exe` is started with. */
	readonly env: NodeJS.ProcessEnv
	/** Default 60 000. */
	readonly timeoutMs?: number
	/** Called for each download the browser refuses, with its suggested file name. */
	readonly onDownloadRefused?: (name: string) => void
	/** For tests. */
	readonly spawnProcess?: StartWindowsBridgeOptions['spawnProcess']
}

const DIRECT_CONNECT_TIMEOUT_MS = 3_000

/** The environment for `powershell.exe`: the caller's, plus the interop socket the plan found. */
export function windowsBridgeEnv(
	plan: WindowsCdpBrowserPlan,
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return plan.interopSocket ? { ...env, WSL_INTEROP: plan.interopSocket } : { ...env }
}

export async function connectWindowsBrowser(
	options: ConnectWindowsBrowserOptions,
): Promise<WindowsBrowserConnection> {
	const { plan } = options
	const timeoutMs = options.timeoutMs ?? 60_000
	const bridge = await WindowsCdpBridge.start({
		powershell: plan.powershell,
		env: windowsBridgeEnv(plan, options.env),
		params: {
			executable: plan.windowsExecutable,
			profile: options.profile,
			...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
			headless: plan.headless,
			closeOnExit: options.closeOnExit,
			launchTimeoutMs: Math.max(5_000, timeoutMs - 15_000),
		},
		...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
	})

	let relay: CdpRelay | undefined
	let browser: Browser | undefined
	let transport: 'relay' | 'direct' = 'relay'
	try {
		if (plan.networkingMode === 'mirrored') {
			browser = await chromium
				.connectOverCDP(`ws://127.0.0.1:${bridge.ready.port}${bridge.ready.path}`, {
					timeout: DIRECT_CONNECT_TIMEOUT_MS,
				})
				.catch(() => undefined)
			if (browser) transport = 'direct'
		}
		if (!browser) {
			relay = await startCdpRelay(bridge)
			browser = await chromium.connectOverCDP(relay.url, { timeout: timeoutMs })
		}
	} catch (error) {
		await relay?.close().catch(() => undefined)
		// A browser the bridge started for a connection that never came up is
		// not wanted: stopping the bridge closes it (when closeOnExit).
		await bridge.stop().catch(() => undefined)
		throw error
	}

	const context = browser.contexts()[0]
	if (!context) {
		await browser.close().catch(() => undefined)
		await relay?.close().catch(() => undefined)
		await bridge.stop().catch(() => undefined)
		throw new Error('The Windows browser has no default context.')
	}

	// Playwright points the browser's downloads at a temporary directory on
	// this side, which on Windows names a path that does not exist (or worse,
	// one that does). Refuse downloads in the browser itself instead, and
	// report each one.
	let session: CDPSession | undefined
	try {
		session = await browser.newBrowserCDPSession()
		await session.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true })
		session.on('Browser.downloadWillBegin', (event: { suggestedFilename?: string }) => {
			options.onDownloadRefused?.(event.suggestedFilename ?? 'a file')
		})
	} catch (error) {
		await browser.close().catch(() => undefined)
		await relay?.close().catch(() => undefined)
		await bridge.stop().catch(() => undefined)
		throw error
	}

	let finished = false
	const finish = async (closeBrowser: boolean): Promise<void> => {
		if (finished) return
		finished = true
		if (closeBrowser) {
			await session
				?.send('Browser.close')
				.then(() => undefined)
				.catch(() => undefined)
		} else {
			bridge.keepBrowser()
		}
		await browser?.close().catch(() => undefined)
		await relay?.close().catch(() => undefined)
		await bridge.stop().catch(() => undefined)
	}
	browser.on('disconnected', () => {
		void relay?.close().catch(() => undefined)
	})
	void bridge.exited.then(() => {
		if (finished) return
		// The bridge went away on its own: killed, or its interop session
		// ended. A Windows process whose WSL side is killed is not told, so
		// the browser it started would stay up with nobody driving it. Under
		// NAT the bridge was the only way to the browser, so the connection is
		// gone too.
		finished = true
		if (transport === 'relay') void browser?.close().catch(() => undefined)
		void relay?.close().catch(() => undefined)
		if (bridge.ready.launched && options.closeOnExit) {
			void closeWindowsBrowser(options, bridge.ready.userDataDir).catch(() => undefined)
		}
	})

	return {
		browser,
		context,
		bridge,
		transport,
		userDataDir: bridge.ready.userDataDir,
		launched: bridge.ready.launched,
		close: () => finish(true),
		detach: () => finish(false),
	}
}

/**
 * Close the browser running on `userDataDir` through a fresh bridge that
 * only attaches (it never starts one): `Browser.close` over CDP, which lets
 * the browser save the profile.
 */
export async function closeWindowsBrowser(
	options: Pick<ConnectWindowsBrowserOptions, 'plan' | 'profile' | 'env' | 'spawnProcess'>,
	userDataDir: string,
): Promise<boolean> {
	let bridge: WindowsCdpBridge
	try {
		bridge = await WindowsCdpBridge.start({
			powershell: options.plan.powershell,
			env: windowsBridgeEnv(options.plan, options.env),
			params: {
				executable: options.plan.windowsExecutable,
				profile: options.profile,
				userDataDir,
				headless: true,
				closeOnExit: false,
				launchTimeoutMs: 5_000,
				attachOnly: true,
			},
			...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
		})
	} catch {
		return false
	}
	bridge.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
	// The bridge exits by itself when the browser drops the connection.
	await bridge.stop(10_000)
	return true
}
