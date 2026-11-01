import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	type WslProbes,
	isWsl,
	realWslProbes,
	wslChildEnv,
	wslPowerShellPath,
} from '../adapters/wsl.js'
import { ForegroundLadder, type LadderTiming } from './ladder.js'
import type { ForegroundApprover } from './types.js'
import { WindowsInputMonitor } from './windows-monitor.js'

/** Variable names never handed to a helper process. */
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

export interface WindowsLadderOptions {
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly wslProbes?: WslProbes
	readonly approve?: ForegroundApprover
	readonly session?: string
	readonly timing?: Partial<LadderTiming>
}

/** `<NAMZU_HOME>/computer-use/screen.lease`, `NAMZU_HOME` defaulting to `~/.namzu`. */
export function screenLeasePath(env: NodeJS.ProcessEnv = process.env): string {
	const home =
		env.NAMZU_HOME && env.NAMZU_HOME.length > 0 ? env.NAMZU_HOME : join(homedir(), '.namzu')
	return join(home, 'computer-use', 'screen.lease')
}

/** A path as Windows names it: a Linux path under WSL goes through the distro's share. */
export function windowsPathFor(path: string, env: NodeJS.ProcessEnv): string {
	const distro = env.WSL_DISTRO_NAME
	if (!path.startsWith('/') || !distro) return path
	return `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
}

/**
 * The foreground ladder for this machine's Windows desktop (WSL included), or
 * undefined where there is no Windows PowerShell to run the helper in.
 */
export function createWindowsForegroundLadder(
	options: WindowsLadderOptions = {},
): ForegroundLadder | undefined {
	const env = options.env ?? process.env
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
	const helperEnv = wsl ? wslChildEnv(clean, [], probes) : clean
	const leasePath = screenLeasePath(env)
	return new ForegroundLadder({
		leasePath,
		createMonitor: () =>
			new WindowsInputMonitor({
				powershell,
				env: helperEnv,
				toWindowsPath: (path) => windowsPathFor(path, env),
			}),
		...(options.approve ? { approve: options.approve } : {}),
		...(options.session ? { session: options.session } : {}),
		...(options.timing ? { timing: options.timing } : {}),
	})
}
