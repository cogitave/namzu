import {
	type WslProbes,
	isWsl,
	realWslProbes,
	wslChildEnv,
	wslPowerShellPath,
} from '../adapters/wsl.js'
import { type Presence, WindowsPresence } from './presence.js'

/** Variable names never handed to a helper process. */
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

/** The environment variable that turns the presence overlay off (`off`, `0`, `false`, `no`). */
export const PRESENCE_ENV = 'NAMZU_COMPUTER_USE_PRESENCE'

export interface WindowsPresenceFactoryOptions {
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly wslProbes?: WslProbes
	/** Default true. `false` shows nothing, whatever the environment says. */
	readonly enabled?: boolean
}

/** Whether the environment asks for the overlay to be off. */
export function presenceDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
	const value = env[PRESENCE_ENV]
	return value !== undefined && /^(off|0|false|no|none)$/i.test(value.trim())
}

/**
 * The presence overlay for this machine's Windows desktop (WSL included), or
 * undefined when it is turned off or there is no Windows PowerShell to run it in.
 */
export function createWindowsPresence(
	options: WindowsPresenceFactoryOptions = {},
): Presence | undefined {
	const env = options.env ?? process.env
	if (options.enabled === false || presenceDisabledByEnv(env)) return undefined
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
	return new WindowsPresence({
		powershell,
		env: wsl ? wslChildEnv(clean, [], probes) : clean,
	})
}
