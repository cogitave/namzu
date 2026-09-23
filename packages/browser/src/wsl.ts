import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WSL facts the Windows browser engine needs: where the Windows drives are
 * mounted, how a Windows path reads from Linux and back, which networking
 * mode the VM runs in, and which interop socket a process without
 * `WSL_INTEROP` (a systemd service) can use to start a Windows program.
 *
 * Every function here is pure over its arguments, except the two listers
 * that read the real file system and say so in their names.
 */

/** `wslinfo --networking-mode`'s answers, plus `unknown` when nothing said. */
export type WslNetworkingMode = 'nat' | 'mirrored' | 'virtioproxy' | 'none' | 'unknown'

const NETWORKING_MODES: readonly WslNetworkingMode[] = ['nat', 'mirrored', 'virtioproxy', 'none']

/** The default mount root for Windows drives. */
export const DEFAULT_WSL_MOUNT_ROOT = '/mnt/'

/**
 * The Linux path of a Windows drive path under `mountRoot` (`/mnt/` unless
 * `/etc/wsl.conf` moved it): `C:\Users\A` → `/mnt/c/Users/A`. `undefined`
 * for anything that is not `<letter>:\…` (a UNC path, a relative path).
 */
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
 * The Windows path of a Linux path on a mounted Windows drive:
 * `/mnt/c/Program Files/x.exe` → `C:\Program Files\x.exe`. `undefined` for a
 * path outside the drive mounts.
 */
export function wslPathToWindows(
	linuxPath: string,
	mountRoot: string = DEFAULT_WSL_MOUNT_ROOT,
): string | undefined {
	const root = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`
	if (!linuxPath.startsWith(root)) return undefined
	const match = /^([a-zA-Z])(?:\/(.*))?$/.exec(linuxPath.slice(root.length))
	if (!match) return undefined
	const drive = (match[1] ?? '').toUpperCase()
	const rest = (match[2] ?? '').replace(/\/+/g, '\\').replace(/\\$/, '')
	return `${drive}:\\${rest}`
}

/** Sections of an INI file (`wsl.conf`, `.wslconfig`), keys lowercased. */
function parseIni(text: string): Map<string, Map<string, string>> {
	const sections = new Map<string, Map<string, string>>()
	let current: Map<string, string> | undefined
	for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = raw.trim()
		if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
		const section = /^\[([^\]]+)\]$/.exec(line)
		if (section) {
			const name = (section[1] ?? '').trim().toLowerCase()
			current = sections.get(name) ?? new Map<string, string>()
			sections.set(name, current)
			continue
		}
		const eq = line.indexOf('=')
		if (eq <= 0 || !current) continue
		const key = line.slice(0, eq).trim().toLowerCase()
		let value = line
			.slice(eq + 1)
			.replace(/\s[#;].*$/, '')
			.trim()
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
		current.set(key, value)
	}
	return sections
}

/** The `[automount] root` of `/etc/wsl.conf`, with a trailing slash; `/mnt/` by default. */
export function parseWslMountRoot(wslConf: string | undefined): string {
	if (!wslConf) return DEFAULT_WSL_MOUNT_ROOT
	const root = parseIni(wslConf).get('automount')?.get('root')
	if (!root || !root.startsWith('/')) return DEFAULT_WSL_MOUNT_ROOT
	return root.endsWith('/') ? root : `${root}/`
}

/** `wslinfo --networking-mode`'s output as a mode; `unknown` for anything else. */
export function parseNetworkingModeOutput(output: string | undefined): WslNetworkingMode {
	const word = (output ?? '').trim().toLowerCase()
	return (NETWORKING_MODES as readonly string[]).includes(word)
		? (word as WslNetworkingMode)
		: 'unknown'
}

/**
 * The networking mode a `.wslconfig` asks for: `[wsl2] networkingMode`, or
 * the older `[experimental] networkingMode`. No setting is NAT, WSL's
 * default; a file that cannot be read is `unknown`.
 */
export function parseWslConfigNetworkingMode(text: string | undefined): WslNetworkingMode {
	if (text === undefined) return 'unknown'
	const ini = parseIni(text)
	const value =
		ini.get('wsl2')?.get('networkingmode') ?? ini.get('experimental')?.get('networkingmode')
	if (value === undefined) return 'nat'
	return parseNetworkingModeOutput(value)
}

/** An interop socket under `/run/WSL`, with its modification time. */
export interface WslInteropSocket {
	readonly path: string
	readonly mtimeMs: number
}

export const WSL_RUN_DIR = '/run/WSL'

/**
 * The interop socket a process without `WSL_INTEROP` can use: a systemd
 * service's, which WSL starts outside any session. `1_interop` is the one WSL
 * links for systemd to the distro's own init, so it lives as long as the
 * distro; failing that, the newest session's. The CLI's desktop
 * notifications choose the same way.
 */
export function findWslInteropSocket(sockets: readonly WslInteropSocket[]): string | undefined {
	const stable = sockets.find((socket) => socket.path === `${WSL_RUN_DIR}/1_interop`)
	if (stable) return stable.path
	return [...sockets].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path
}

/** The interop sockets under `/run/WSL` on this machine. Reads the file system. */
export function listWslInteropSockets(dir: string = WSL_RUN_DIR): WslInteropSocket[] {
	const sockets: WslInteropSocket[] = []
	let names: string[]
	try {
		names = readdirSync(dir)
	} catch {
		return sockets
	}
	for (const name of names) {
		if (!/^\d+_interop$/.test(name)) continue
		const path = join(dir, name)
		try {
			const stat = statSync(path)
			if (stat.isSocket()) sockets.push({ path, mtimeMs: stat.mtimeMs })
		} catch {
			// Gone between the listing and the stat: a session that just ended.
		}
	}
	return sockets
}
