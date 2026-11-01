/**
 * Whether this process runs inside WSL, and how Windows paths read from it.
 *
 * Kept here, not imported from the browser package, because that package is
 * loaded lazily (it is heavy) and the clipboard path must stay cheap. Only
 * the few pure functions the clipboard needs live here.
 */

import { readFileSync } from 'node:fs'

export const DEFAULT_WSL_MOUNT_ROOT = '/mnt/'

export interface WslProbe {
	readonly platform: NodeJS.Platform
	readonly env: Readonly<Record<string, string | undefined>>
	/** The text of a file, or `undefined` when it cannot be read. */
	readonly readText: (path: string) => string | undefined
}

export function readTextOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return undefined
	}
}

/** WSL sets one of two variables; failing that the kernel's version string names it. */
export function isWslEnv(probe: WslProbe): boolean {
	if (probe.platform !== 'linux') return false
	if (probe.env.WSL_DISTRO_NAME || probe.env.WSL_INTEROP) return true
	const version = probe.readText('/proc/version')?.toLowerCase() ?? ''
	return version.includes('microsoft') || version.includes('wsl')
}

/** The `[automount] root` of `/etc/wsl.conf`, with a trailing slash; `/mnt/` by default. */
export function parseWslMountRoot(wslConf: string | undefined): string {
	if (!wslConf) return DEFAULT_WSL_MOUNT_ROOT
	let inAutomount = false
	for (const raw of wslConf.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = raw.trim()
		const section = /^\[([^\]]+)\]$/.exec(line)
		if (section) {
			inAutomount = (section[1] ?? '').trim().toLowerCase() === 'automount'
			continue
		}
		if (!inAutomount) continue
		const match = /^root\s*=\s*(.*?)\s*(?:[#;].*)?$/i.exec(line)
		if (!match) continue
		const root = (match[1] ?? '').replace(/^(["'])(.*)\1$/, '$2')
		if (!root.startsWith('/')) return DEFAULT_WSL_MOUNT_ROOT
		return root.endsWith('/') ? root : `${root}/`
	}
	return DEFAULT_WSL_MOUNT_ROOT
}

/** `C:\Users\A` to `/mnt/c/Users/A`. `undefined` when it is not a drive path. */
export function windowsPathToWsl(
	windowsPath: string,
	mountRoot: string = DEFAULT_WSL_MOUNT_ROOT,
): string | undefined {
	const match = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(windowsPath)
	if (!match) return undefined
	const drive = (match[1] ?? '').toLowerCase()
	const rest = (match[2] ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '')
	const root = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`
	return rest.length > 0 ? `${root}${drive}/${rest}` : `${root}${drive}`
}

/**
 * A path on this distribution's own share (`\\wsl$\Distro\home\a` or
 * `\\wsl.localhost\Distro\home\a`) as the Linux path `/home/a`. `undefined`
 * for another distribution (not reachable from here) or any other UNC path.
 */
export function wslSharePathToLinux(
	uncPath: string,
	distro: string | undefined,
): string | undefined {
	const match = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(?:\\(.*))?$/i.exec(uncPath)
	if (!match || !distro) return undefined
	if ((match[1] ?? '').toLowerCase() !== distro.toLowerCase()) return undefined
	return `/${(match[2] ?? '').replace(/\\+/g, '/')}`.replace(/(.)\/$/, '$1')
}

export interface PathEnvironment {
	readonly wsl: boolean
	/** The WSL distribution's name, for `\\wsl$\<name>` paths. */
	readonly distro?: string
	readonly mountRoot: string
}

let memo: PathEnvironment | undefined

/** This process's WSL facts, worked out once. */
export function currentPathEnvironment(): PathEnvironment {
	if (memo) return memo
	const wsl = isWslEnv({
		platform: process.platform,
		env: process.env,
		readText: readTextOrUndefined,
	})
	memo = {
		wsl,
		...(process.env.WSL_DISTRO_NAME ? { distro: process.env.WSL_DISTRO_NAME } : {}),
		mountRoot: wsl
			? parseWslMountRoot(readTextOrUndefined('/etc/wsl.conf'))
			: DEFAULT_WSL_MOUNT_ROOT,
	}
	return memo
}
