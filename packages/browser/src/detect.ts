import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import {
	DEFAULT_WSL_MOUNT_ROOT,
	WSL_RUN_DIR,
	type WslNetworkingMode,
	findWslInteropSocket,
	parseNetworkingModeOutput,
	parseWslConfigNetworkingMode,
	parseWslMountRoot,
	wslPathToWindows,
} from './wsl.js'

/**
 * Which browser runs, where, and whether its window is shown — decided from
 * the environment before anything is launched.
 *
 * | Where namzu runs | Plan |
 * | --- | --- |
 * | WSL2 with interop and a Windows Chrome or Edge | `windows-cdp` — the Windows browser, driven over CDP |
 * | WSL2 without either | `local` Chromium inside WSL (a warning says why); headed through WSLg when there is a display |
 * | Linux with a display | `local`: Google Chrome if installed, else Playwright's Chromium |
 * | Linux without a display | `local`, headless only |
 * | macOS | `local`: Google Chrome if installed, else Playwright's Chromium |
 * | Windows | `local`: Chrome, else Edge, else Playwright's Chromium |
 *
 * The `windows-cdp` engine starts the Windows browser through `powershell.exe`
 * and talks CDP to it through that process's standard streams (see
 * `windows-bridge.ts`), because WSL's NAT networking cannot reach Windows'
 * `127.0.0.1`. Under mirrored networking it connects directly and keeps the
 * bridge only to start and stop the browser.
 */

/** `auto` follows the table; `windows` and `local` force one engine. */
export type BrowserEngineSetting = 'auto' | 'windows' | 'local'

/** `auto`: a window when there is a display and a person at it (`interactive`). */
export type BrowserHeadlessSetting = 'auto' | 'always' | 'never'

/** `interactive`: a person is at the terminal. `unattended`: a scheduled run. */
export type BrowserRunMode = 'interactive' | 'unattended'

export type BrowserHostPlatform = 'linux' | 'wsl' | 'darwin' | 'win32'

/** The file-system questions detection asks; injected so tests need no real machine. */
export interface BrowserEnvironmentProbes {
	exists(path: string): boolean
	/** The file's text, or `undefined` if it cannot be read. */
	readFile(path: string): string | undefined
	/** Entry names, or `[]` if the directory cannot be read. */
	listDir(path: string): readonly string[]
	/** Modification time in ms, or `undefined`. Absent: every file is equally old. */
	modifiedMs?(path: string): number | undefined
	/**
	 * Standard output of a short-lived program, or `undefined` if it failed.
	 * Absent: nothing is run (`wslinfo` is skipped and `.wslconfig` decides).
	 */
	run?(file: string, args: readonly string[]): string | undefined
}

export interface DetectBrowserEnvironmentOptions {
	readonly engine?: BrowserEngineSetting
	readonly headless?: BrowserHeadlessSetting
	readonly mode?: BrowserRunMode
	/** Under WSL: which Windows browser to drive. Default Chrome, else Edge. */
	readonly windowsBrowser?: 'chrome' | 'msedge'
}

/** A browser this process launches itself, with Playwright. */
export interface LocalBrowserPlan {
	readonly engine: 'local'
	readonly platform: BrowserHostPlatform
	/** `chromium` is Playwright's own build, from its browser cache. */
	readonly browser: 'chrome' | 'msedge' | 'chromium'
	/** The Playwright channel for an installed browser; absent for Playwright's Chromium. */
	readonly channel?: 'chrome' | 'msedge'
	readonly headless: boolean
	/** A display is available for a visible window. */
	readonly display: boolean
	readonly warnings: readonly string[]
	/** Present when this plan cannot run at all. */
	readonly unavailableReason?: string
}

/** The Windows browser, driven from WSL over CDP. */
export interface WindowsCdpBrowserPlan {
	readonly engine: 'windows-cdp'
	readonly platform: 'wsl'
	readonly browser: 'chrome' | 'msedge'
	/** The browser as WSL sees it (`/mnt/c/Program Files/…/chrome.exe`). */
	readonly executable: string
	/** The browser as Windows sees it (`C:\Program Files\…\chrome.exe`). */
	readonly windowsExecutable: string
	/** `powershell.exe`, absolute, as WSL sees it. */
	readonly powershell: string
	/** Where the Windows drives are mounted, with a trailing slash (`/mnt/`). */
	readonly mountRoot: string
	/** `mirrored` lets WSL reach Windows' `127.0.0.1` directly; anything else goes through the bridge. */
	readonly networkingMode: WslNetworkingMode
	/**
	 * The interop socket to hand a Windows program as `WSL_INTEROP`, when this
	 * process has none of its own (a systemd service). Absent when the
	 * environment's `WSL_INTEROP` works.
	 */
	readonly interopSocket?: string
	readonly headless: boolean
	readonly display: true
	readonly warnings: readonly string[]
	readonly unavailableReason?: string
	/** What to run instead when this engine is unavailable and was not forced. */
	readonly fallback?: LocalBrowserPlan
}

export type BrowserEnginePlan = LocalBrowserPlan | WindowsCdpBrowserPlan

/** Probes over the real file system. */
export const nodeBrowserProbes: BrowserEnvironmentProbes = {
	exists: (path) => {
		try {
			return existsSync(path)
		} catch {
			return false
		}
	},
	readFile: (path) => {
		try {
			return readFileSync(path, 'utf8')
		} catch {
			return undefined
		}
	},
	listDir: (path) => {
		try {
			return readdirSync(path)
		} catch {
			return []
		}
	},
	modifiedMs: (path) => {
		try {
			return statSync(path).mtimeMs
		} catch {
			return undefined
		}
	},
	run: (file, args) => {
		try {
			return execFileSync(file, [...args], {
				encoding: 'utf8',
				timeout: 3_000,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
		} catch {
			return undefined
		}
	},
}

const WSL_POWERSHELL_TAIL = 'c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** Where the Windows browsers install, relative to the mount root. */
const WSL_WINDOWS_BROWSERS: readonly { browser: 'chrome' | 'msedge'; tail: string }[] = [
	{ browser: 'chrome', tail: 'c/Program Files/Google/Chrome/Application/chrome.exe' },
	{ browser: 'chrome', tail: 'c/Program Files (x86)/Google/Chrome/Application/chrome.exe' },
	{ browser: 'msedge', tail: 'c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
	{ browser: 'msedge', tail: 'c/Program Files/Microsoft/Edge/Application/msedge.exe' },
]

const WSLINFO = '/usr/bin/wslinfo'

/** Profile folders under `C:\Users` that are not a person's. */
const NOT_A_USER = new Set(['all users', 'default', 'default user', 'public', 'desktop.ini'])

/**
 * The VM's networking mode: `wslinfo --networking-mode` when WSL has it;
 * otherwise the one `.wslconfig` under `C:\Users` (when exactly one user has
 * one); otherwise `unknown`, which is treated as NAT.
 */
export function wslNetworkingMode(
	probes: BrowserEnvironmentProbes,
	mountRoot: string = DEFAULT_WSL_MOUNT_ROOT,
): WslNetworkingMode {
	if (probes.run && probes.exists(WSLINFO)) {
		const mode = parseNetworkingModeOutput(probes.run(WSLINFO, ['--networking-mode']))
		if (mode !== 'unknown') return mode
	}
	const users = `${mountRoot}c/Users`
	const configs = probes
		.listDir(users)
		.filter((name) => !NOT_A_USER.has(name.toLowerCase()))
		.map((name) => `${users}/${name}/.wslconfig`)
		.filter((path) => probes.exists(path))
	if (configs.length !== 1) return 'unknown'
	return parseWslConfigNetworkingMode(probes.readFile(configs[0] as string))
}

/**
 * The interop socket to give a Windows program: the environment's
 * `WSL_INTEROP` when it exists, else one under `/run/WSL`.
 */
export function wslInteropSocket(
	env: NodeJS.ProcessEnv,
	probes: BrowserEnvironmentProbes,
): string | undefined {
	if (env.WSL_INTEROP && probes.exists(env.WSL_INTEROP)) return env.WSL_INTEROP
	const sockets = probes
		.listDir(WSL_RUN_DIR)
		.filter((name) => /^\d+_interop$/.test(name))
		.map((name) => {
			const path = `${WSL_RUN_DIR}/${name}`
			return { path, mtimeMs: probes.modifiedMs?.(path) ?? 0 }
		})
	return findWslInteropSocket(sockets)
}

const LINUX_CHROME = ['/opt/google/chrome/chrome']
const DARWIN_CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']

function windowsBrowserPaths(
	env: NodeJS.ProcessEnv,
	browser: 'chrome' | 'msedge',
): readonly string[] {
	const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
		(root): root is string => typeof root === 'string' && root.length > 0,
	)
	const tail =
		browser === 'chrome'
			? '\\Google\\Chrome\\Application\\chrome.exe'
			: '\\Microsoft\\Edge\\Application\\msedge.exe'
	return roots.map((root) => `${root.replace(/[\\/]+$/, '')}${tail}`)
}

/** Is this Linux kernel WSL's? The environment variables are absent under a systemd service. */
export function isWsl(env: NodeJS.ProcessEnv, probes: BrowserEnvironmentProbes): boolean {
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true
	const release = probes.readFile('/proc/sys/kernel/osrelease') ?? ''
	return /microsoft|wsl/i.test(release)
}

/**
 * Can this WSL process start Windows programs? The binfmt handler must be
 * registered, and a socket must be reachable: `WSL_INTEROP`, or one under
 * `/run/WSL` (all a systemd user service has).
 */
export function wslInteropAvailable(
	env: NodeJS.ProcessEnv,
	probes: BrowserEnvironmentProbes,
): boolean {
	const registered =
		probes.exists('/proc/sys/fs/binfmt_misc/WSLInterop') ||
		probes.exists('/proc/sys/fs/binfmt_misc/WSLInterop-late')
	if (!registered) return false
	if (env.WSL_INTEROP && probes.exists(env.WSL_INTEROP)) return true
	return probes.listDir('/run/WSL').some((name) => name.endsWith('_interop'))
}

function hasDisplay(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

function headlessFor(
	setting: BrowserHeadlessSetting,
	mode: BrowserRunMode,
	display: boolean,
): { headless: boolean; unavailableReason?: string } {
	if (setting === 'always') return { headless: true }
	if (setting === 'never') {
		return display
			? { headless: false }
			: {
					headless: false,
					unavailableReason:
						'A visible browser window was asked for (headless: never), but there is no display: neither DISPLAY nor WAYLAND_DISPLAY is set. Run under a desktop session, with ssh -X, or with xvfb-run.',
				}
	}
	return { headless: !(display && mode === 'interactive') }
}

function localPlan(
	platform: BrowserHostPlatform,
	env: NodeJS.ProcessEnv,
	probes: BrowserEnvironmentProbes,
	options: Required<Omit<DetectBrowserEnvironmentOptions, 'windowsBrowser'>>,
	warnings: string[],
): LocalBrowserPlan {
	const display = platform === 'darwin' || platform === 'win32' ? true : hasDisplay(env)
	let browser: LocalBrowserPlan['browser'] = 'chromium'
	if (platform === 'linux' || platform === 'wsl') {
		if (LINUX_CHROME.some((p) => probes.exists(p))) browser = 'chrome'
	} else if (platform === 'darwin') {
		if (DARWIN_CHROME.some((p) => probes.exists(p))) browser = 'chrome'
	} else if (windowsBrowserPaths(env, 'chrome').some((p) => probes.exists(p))) {
		browser = 'chrome'
	} else if (windowsBrowserPaths(env, 'msedge').some((p) => probes.exists(p))) {
		browser = 'msedge'
	}
	if (!display) {
		warnings.push(
			'No display (DISPLAY and WAYLAND_DISPLAY are unset): the browser runs headless, and signing in to a profile needs a machine with a display.',
		)
	}
	const { headless, unavailableReason } = headlessFor(options.headless, options.mode, display)
	return {
		engine: 'local',
		platform,
		browser,
		...(browser === 'chromium' ? {} : { channel: browser }),
		headless,
		display,
		warnings,
		...(unavailableReason !== undefined ? { unavailableReason } : {}),
	}
}

/**
 * The engine plan for this environment. Pure over its arguments: the
 * environment, the platform, and the probes answer every question.
 */
export function detectBrowserEnvironment(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	probes: BrowserEnvironmentProbes = nodeBrowserProbes,
	options: DetectBrowserEnvironmentOptions = {},
): BrowserEnginePlan {
	const settings: Required<Omit<DetectBrowserEnvironmentOptions, 'windowsBrowser'>> = {
		engine: options.engine ?? 'auto',
		headless: options.headless ?? 'auto',
		mode: options.mode ?? 'interactive',
	}

	if (platform === 'darwin' || platform === 'win32') {
		const plan = localPlan(platform, env, probes, settings, [])
		if (settings.engine === 'windows') {
			return {
				...plan,
				unavailableReason:
					'engine "windows" drives a Windows browser from WSL; this is not WSL. Use engine "auto" or "local".',
			}
		}
		return plan
	}
	if (platform !== 'linux') {
		return {
			engine: 'local',
			platform: 'linux',
			browser: 'chromium',
			headless: true,
			display: false,
			warnings: [],
			unavailableReason: `The browser is not supported on ${platform}.`,
		}
	}

	if (!isWsl(env, probes)) {
		const plan = localPlan('linux', env, probes, settings, [])
		if (settings.engine === 'windows') {
			return {
				...plan,
				unavailableReason:
					'engine "windows" drives a Windows browser from WSL; this is not WSL. Use engine "auto" or "local".',
			}
		}
		return plan
	}

	// WSL.
	if (settings.engine === 'local') return localPlan('wsl', env, probes, settings, [])
	const mountRoot = parseWslMountRoot(probes.readFile('/etc/wsl.conf'))
	const interop = wslInteropAvailable(env, probes)
	const powershellPath = `${mountRoot}${WSL_POWERSHELL_TAIL}`
	const powershell = probes.exists(powershellPath) ? powershellPath : undefined
	const installed = WSL_WINDOWS_BROWSERS.map((b) => ({
		browser: b.browser,
		path: `${mountRoot}${b.tail}`,
	})).filter((b) => probes.exists(b.path))
	const preferred = options.windowsBrowser
	const windowsBrowser =
		(preferred ? installed.find((b) => b.browser === preferred) : undefined) ?? installed[0]
	const warnings: string[] = []
	if (preferred && windowsBrowser && windowsBrowser.browser !== preferred) {
		warnings.push(
			`${preferred === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} is not installed on Windows; using ${windowsBrowser.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'}.`,
		)
	}
	if (!interop || !powershell || !windowsBrowser) {
		const why = !interop
			? 'WSL interop is off, so Windows programs cannot be started'
			: !powershell
				? `powershell.exe was not found at ${powershellPath}`
				: 'no Windows Chrome or Edge was found under C:\\Program Files'
		if (settings.engine === 'windows') {
			return {
				...localPlan('wsl', env, probes, settings, []),
				unavailableReason: `engine "windows" was asked for, but ${why}.`,
			}
		}
		return localPlan('wsl', env, probes, settings, [
			`Using Chromium inside WSL: ${why}. Sites see a Linux browser, and a visible window needs WSLg.`,
		])
	}
	// The Windows browser has the Windows desktop for a display, whatever
	// WSLg says; headless follows the setting and the mode alone.
	const { headless } = headlessFor(settings.headless, settings.mode, true)
	const socket = wslInteropSocket(env, probes)
	const windowsExecutable = wslPathToWindows(windowsBrowser.path, mountRoot) as string
	return {
		engine: 'windows-cdp',
		platform: 'wsl',
		browser: windowsBrowser.browser,
		executable: windowsBrowser.path,
		windowsExecutable,
		powershell,
		mountRoot,
		networkingMode: wslNetworkingMode(probes, mountRoot),
		...(socket !== undefined && socket !== env.WSL_INTEROP ? { interopSocket: socket } : {}),
		headless,
		display: true,
		warnings,
	}
}

/**
 * The plan to actually run: the plan itself, or its fallback when it is
 * unavailable and has one. Still possibly unavailable — check
 * `unavailableReason`.
 */
export function runnableBrowserPlan(plan: BrowserEnginePlan): BrowserEnginePlan {
	if (plan.unavailableReason !== undefined && plan.engine === 'windows-cdp' && plan.fallback) {
		return plan.fallback
	}
	return plan
}
