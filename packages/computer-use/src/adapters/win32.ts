import type { AccessibilityBackend } from '../a11y/interface.js'
import { guardForeground } from '../foreground/guard.js'
import type { ForegroundLadder } from '../foreground/ladder.js'
import { windowsPathFor } from '../foreground/windows.js'
import type { NativeWinProcessOptions } from '../native/process.js'
import type { Presence } from '../presence/presence.js'
import { CuaDriverAdapter } from './cua-driver/adapter.js'
import {
	CUA_DRIVER_RELEASE,
	type ResolveCuaDriverOptions,
	resolveCuaDriver,
} from './cua-driver/provision.js'
import { type Adapter, AdapterUnavailableError } from './types.js'
import { NativeWin32Adapter } from './win32-native.js'
import { Win32PowerShellAdapter } from './win32-powershell.js'
import { type WslProbes, isWsl, realWslProbes, wslChildEnv } from './wsl.js'

/**
 * Which Windows backend drives the desktop.
 *
 * - `auto` (the default): cua-driver — the pinned build, downloaded and
 *   checked on first use — and, when it cannot be had or does not answer,
 *   the per-action path, with the reason on `fallbackReason`.
 * - `cua-driver`: cua-driver or nothing; its failure is the adapter's.
 * - `powershell`: never cua-driver.
 *
 * The per-action path is the native helper (`namzu-win`) when one is
 * configured (`NAMZU_WIN_HELPER`, or the `helper` option) and PowerShell
 * otherwise. With a helper configured there is no PowerShell fallback: a
 * helper that does not start is an error, not a reason to run scripts.
 */
export type Win32Backend = 'auto' | 'cua-driver' | 'powershell'

export interface Win32AdapterOptions {
	readonly backend?: Win32Backend
	/** An existing `cua-driver.exe` to run instead of the pinned build. */
	readonly cuaDriverPath?: string
	/** Where the pinned build is kept. Default `<NAMZU_HOME>/computer-use/cua-driver/<version>`. */
	readonly cacheDir?: string
	/** Download the pinned build when it is missing. Default true. */
	readonly download?: boolean
	/** Told once, in plain words, before the pinned build is downloaded. */
	readonly onNotice?: (notice: string) => void
	/**
	 * The path of the native helper, `namzu-win.exe`. Default: the
	 * `NAMZU_WIN_HELPER` variable. Set, the helper is the per-action path and
	 * PowerShell is never started for display input or capture.
	 */
	readonly helper?: string
	/** Where the helper writes its pictures. Default: a private temporary directory. */
	readonly captureDir?: string
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	/**
	 * Where input that can only be delivered in the foreground goes: through
	 * the idle gate, the screen lease and a restore. Absent, display input and
	 * `focusWindow` act at once, as before.
	 */
	readonly foreground?: ForegroundLadder
	/** The agent cursor and window border shown while a window is operated. Absent, none. */
	readonly presence?: Presence
	/** The resident accessibility host the driver backend serves its window list from. Absent, the driver does. */
	readonly a11y?: AccessibilityBackend
	/** For tests. */
	readonly wslProbes?: WslProbes
	/** For tests. */
	readonly resolve?: typeof resolveCuaDriver
	/** For tests: starts the native helper's process. */
	readonly spawnHelper?: NativeWinProcessOptions['spawnHelper']
	/** For tests. */
	readonly createCuaDriverAdapter?: (
		options: ConstructorParameters<typeof CuaDriverAdapter>[0],
	) => Adapter
}

/** Variables cua-driver reads that this adapter sets for it. */
const CUA_DRIVER_SETTINGS = {
	// Default-on product telemetry: off.
	CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
	// The release check against GitHub: off; this package pins the build.
	CUA_DRIVER_RS_UPDATE_CHECK: '0',
} as const

/** Variable names never handed to a third-party program. */
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

/**
 * The environment cua-driver runs with: the caller's minus anything named
 * like a secret, plus {@link CUA_DRIVER_SETTINGS}; under WSL, with a working
 * `WSL_INTEROP` and the settings forwarded through `WSLENV`.
 */
export function cuaDriverEnvironment(
	env: NodeJS.ProcessEnv,
	wsl: boolean,
	probes: WslProbes = realWslProbes,
): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {}
	for (const [name, value] of Object.entries(env)) {
		if (!SECRET_NAME.test(name)) base[name] = value
	}
	Object.assign(base, CUA_DRIVER_SETTINGS)
	return wsl ? wslChildEnv(base, Object.keys(CUA_DRIVER_SETTINGS), probes) : base
}

/** The environment the native helper runs with: the caller's minus anything named like a secret; under WSL, with a working `WSL_INTEROP`. */
export function nativeHelperEnvironment(
	env: NodeJS.ProcessEnv,
	wsl: boolean,
	probes: WslProbes = realWslProbes,
): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {}
	for (const [name, value] of Object.entries(env)) {
		if (!SECRET_NAME.test(name)) base[name] = value
	}
	return wsl ? wslChildEnv(base, [], probes) : base
}

/**
 * `NAMZU_CUA_DRIVER`: `off` keeps cua-driver out (the PowerShell path);
 * a path names the `cua-driver.exe` to run instead of the pinned build.
 */
function fromEnvironment(env: NodeJS.ProcessEnv): { off: boolean; path?: string } {
	const value = env.NAMZU_CUA_DRIVER?.trim()
	if (!value) return { off: false }
	if (/^(off|0|false|no|none)$/i.test(value)) return { off: true }
	return { off: false, path: value }
}

export class Win32Adapter {
	/** The Windows adapter for this host; see {@link Win32Backend}. */
	static async create(options: Win32AdapterOptions = {}): Promise<Adapter> {
		const env = options.env ?? process.env
		const platform = options.platform ?? process.platform
		const probes = options.wslProbes ?? realWslProbes
		const configured = fromEnvironment(env)
		const backend: Win32Backend = options.backend ?? (configured.off ? 'powershell' : 'auto')
		const ladder = options.foreground
		const guard = (adapter: Adapter): Adapter =>
			ladder ? guardForeground(adapter, ladder) : adapter
		const helper = (options.helper ?? env.NAMZU_WIN_HELPER)?.trim()
		// The per-action path: the native helper when one is named, else PowerShell.
		// A helper that does not start throws; it never turns into PowerShell.
		const perAction = async (fallbackReason?: string) => {
			if (helper) {
				const wsl = isWsl(env, platform, probes)
				return guard(
					await NativeWin32Adapter.create({
						executable: helper,
						env: nativeHelperEnvironment(env, wsl, probes),
						...(options.captureDir ? { captureDir: options.captureDir } : {}),
						...(wsl ? { toHelperPath: (path: string) => windowsPathFor(path, env) } : {}),
						...(options.spawnHelper ? { spawnHelper: options.spawnHelper } : {}),
					}),
				)
			}
			return guard(
				await Win32PowerShellAdapter.create({
					env,
					platform,
					wslProbes: probes,
					fallbackReason,
				}),
			)
		}
		if (backend === 'powershell') return perAction()

		const cuaDriverPath = options.cuaDriverPath ?? configured.path
		let adapter: Adapter | undefined
		try {
			const resolveOptions: ResolveCuaDriverOptions = {
				env,
				...(cuaDriverPath !== undefined ? { path: cuaDriverPath } : {}),
				...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
				...(options.download !== undefined ? { download: options.download } : {}),
				...(options.onNotice ? { onDownload: options.onNotice } : {}),
			}
			const resolved = await (options.resolve ?? resolveCuaDriver)(resolveOptions)
			const wsl = isWsl(env, platform, probes)
			const adapterOptions = {
				executable: resolved.path,
				env: cuaDriverEnvironment(env, wsl, probes),
				...(resolved.source === 'configured' ? {} : { version: CUA_DRIVER_RELEASE.version }),
				...(ladder ? { foreground: ladder } : {}),
				...(options.presence ? { presence: options.presence } : {}),
				...(options.a11y ? { a11y: options.a11y } : {}),
			}
			adapter = options.createCuaDriverAdapter
				? options.createCuaDriverAdapter(adapterOptions)
				: new CuaDriverAdapter(adapterOptions)
			// Starts the driver and proves it reaches the desktop.
			await adapter.getDisplayGeometry()
			return guard(adapter)
		} catch (error) {
			await adapter?.dispose?.().catch(() => undefined)
			const reason = error instanceof Error ? error.message : String(error)
			if (backend === 'cua-driver') {
				throw new AdapterUnavailableError(`Win32Adapter: cua-driver is not usable: ${reason}`)
			}
			return perAction(reason)
		}
	}
}
