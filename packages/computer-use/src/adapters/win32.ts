import { CuaDriverAdapter } from './cua-driver/adapter.js'
import {
	CUA_DRIVER_RELEASE,
	type ResolveCuaDriverOptions,
	resolveCuaDriver,
} from './cua-driver/provision.js'
import { type Adapter, AdapterUnavailableError } from './types.js'
import { Win32PowerShellAdapter } from './win32-powershell.js'
import { type WslProbes, isWsl, realWslProbes, wslChildEnv } from './wsl.js'

/**
 * Which Windows backend drives the desktop.
 *
 * - `auto` (the default): cua-driver — the pinned build, downloaded and
 *   checked on first use — and, when it cannot be had or does not answer,
 *   the per-action PowerShell path, with the reason on `fallbackReason`.
 * - `cua-driver`: cua-driver or nothing; its failure is the adapter's.
 * - `powershell`: never cua-driver.
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
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	/** For tests. */
	readonly wslProbes?: WslProbes
	/** For tests. */
	readonly resolve?: typeof resolveCuaDriver
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
		const powershell = (fallbackReason?: string) =>
			Win32PowerShellAdapter.create({ env, platform, wslProbes: probes, fallbackReason })
		if (backend === 'powershell') return powershell()

		const cuaDriverPath = options.cuaDriverPath ?? configured.path
		let adapter: Adapter | undefined
		try {
			const resolveOptions: ResolveCuaDriverOptions = {
				env,
				...(cuaDriverPath !== undefined ? { path: cuaDriverPath } : {}),
				...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
				...(options.download !== undefined ? { download: options.download } : {}),
			}
			const resolved = await (options.resolve ?? resolveCuaDriver)(resolveOptions)
			const wsl = isWsl(env, platform, probes)
			const adapterOptions = {
				executable: resolved.path,
				env: cuaDriverEnvironment(env, wsl, probes),
				...(resolved.source === 'configured' ? {} : { version: CUA_DRIVER_RELEASE.version }),
			}
			adapter = options.createCuaDriverAdapter
				? options.createCuaDriverAdapter(adapterOptions)
				: new CuaDriverAdapter(adapterOptions)
			// Starts the driver and proves it reaches the desktop.
			await adapter.getDisplayGeometry()
			return adapter
		} catch (error) {
			await adapter?.dispose?.().catch(() => undefined)
			const reason = error instanceof Error ? error.message : String(error)
			if (backend === 'cua-driver') {
				throw new AdapterUnavailableError(`Win32Adapter: cua-driver is not usable: ${reason}`)
			}
			return powershell(reason)
		}
	}
}
