import {
	type WslProbes,
	isWsl,
	realWslProbes,
	wslChildEnv,
	wslPowerShellPath,
} from '../adapters/wsl.js'
import { WindowsA11yHost } from './a11y.js'
import type { AccessibilityBackend } from './interface.js'

/** Variable names never handed to a helper process. */
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

/** The environment variable that turns the accessibility host off (`off`, `0`, `false`, `no`). */
export const A11Y_ENV = 'NAMZU_COMPUTER_USE_A11Y'

export interface WindowsA11yFactoryOptions {
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly wslProbes?: WslProbes
	/** Default true. `false` starts nothing, whatever the environment says. */
	readonly enabled?: boolean
}

/** Whether the environment asks for the accessibility host to be off. */
export function a11yDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
	const value = env[A11Y_ENV]
	return value !== undefined && /^(off|0|false|no|none)$/i.test(value.trim())
}

/**
 * The accessibility host for this machine's Windows desktop (WSL included),
 * or undefined when it is turned off or there is no Windows PowerShell to run
 * it in. Nothing is started until it is first used or warmed.
 */
export function createWindowsA11yHost(
	options: WindowsA11yFactoryOptions = {},
): AccessibilityBackend | undefined {
	const env = options.env ?? process.env
	if (options.enabled === false || a11yDisabledByEnv(env)) return undefined
	const platform = options.platform ?? process.platform
	const probes = options.wslProbes ?? realWslProbes
	const wsl = isWsl(env, platform, probes)
	const powershell = wsl
		? wslPowerShellPath(probes)
		: platform === 'win32'
			? 'powershell.exe'
			: undefined
	if (!powershell) return undefined
	const clean: NodeJS.ProcessEnv = {}
	for (const [name, value] of Object.entries(env)) if (!SECRET_NAME.test(name)) clean[name] = value
	return new WindowsA11yHost({
		powershell,
		env: wsl ? wslChildEnv(clean, [], probes) : clean,
	})
}
