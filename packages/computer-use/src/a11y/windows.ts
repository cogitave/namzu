import {
	type WslProbes,
	isWsl,
	realWslProbes,
	wslChildEnv,
	wslPowerShellPath,
} from '../adapters/wsl.js'
import { NativeA11yBackend } from '../native/a11y.js'
import { NATIVE_HELPER_ENV, nativeHelperFromEnv } from '../native/env.js'
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

/**
 * The path of the native helper (`namzu-native.exe`). While the helper is not
 * delivered with the product, naming it here is how it is chosen over the
 * PowerShell host; unset, nothing changes.
 */
/** @deprecated Use `NATIVE_HELPER_ENV`; the old `NAMZU_WIN_HELPER` is still read as a fallback. */
export const WIN_HELPER_ENV = NATIVE_HELPER_ENV

function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean: NodeJS.ProcessEnv = {}
	for (const [name, value] of Object.entries(env)) if (!SECRET_NAME.test(name)) clean[name] = value
	return clean
}

/** Whether the environment asks for the accessibility host to be off. */
export function a11yDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
	const value = env[A11Y_ENV]
	return value !== undefined && /^(off|0|false|no|none)$/i.test(value.trim())
}

/**
 * The accessibility host for this machine's Windows desktop (WSL included),
 * or undefined when it is turned off or there is neither a native helper nor
 * a Windows PowerShell to run it in. Nothing is started until it is first
 * used or warmed.
 *
 * With `NAMZU_NATIVE_HELPER` naming an executable, the host is the native helper
 * and no PowerShell is involved. The variable is the only way to choose it
 * for now.
 */
export function createWindowsA11yHost(
	options: WindowsA11yFactoryOptions = {},
): AccessibilityBackend | undefined {
	const env = options.env ?? process.env
	if (options.enabled === false || a11yDisabledByEnv(env)) return undefined
	const platform = options.platform ?? process.platform
	const probes = options.wslProbes ?? realWslProbes
	const wsl = isWsl(env, platform, probes)
	const clean = withoutSecrets(env)
	const helper = nativeHelperFromEnv(env)
	if (helper && (wsl || platform === 'win32')) {
		return new NativeA11yBackend({
			executable: helper,
			env: wsl ? wslChildEnv(clean, [], probes) : clean,
		})
	}
	const powershell = wsl
		? wslPowerShellPath(probes)
		: platform === 'win32'
			? 'powershell.exe'
			: undefined
	if (!powershell) return undefined
	return new WindowsA11yHost({
		powershell,
		env: wsl ? wslChildEnv(clean, [], probes) : clean,
	})
}
