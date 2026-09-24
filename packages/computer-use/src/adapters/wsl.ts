import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The WSL facts the Windows adapter needs: is this WSL, where the Windows
 * drives are mounted, which interop socket a process without a working
 * `WSL_INTEROP` (a systemd service) can use to start a Windows program, and
 * how to forward variables to one.
 *
 * A minimal copy of `@namzu/browser`'s `wsl.ts` and `detect.ts`: leaf
 * packages do not import one another.
 */

/** What the helpers read from the machine; replaced in tests. */
export interface WslProbes {
	readFile(path: string): string | undefined
	exists(path: string): boolean
	/** Interop sockets under `/run/WSL`, with modification times. */
	interopSockets(): readonly { readonly path: string; readonly mtimeMs: number }[]
}

export const WSL_RUN_DIR = '/run/WSL'
export const DEFAULT_WSL_MOUNT_ROOT = '/mnt/'
const WSL_POWERSHELL_TAIL = 'c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

export const realWslProbes: WslProbes = {
	readFile(path) {
		try {
			return readFileSync(path, 'utf8')
		} catch {
			return undefined
		}
	},
	exists(path) {
		return existsSync(path)
	},
	interopSockets() {
		let names: string[]
		try {
			names = readdirSync(WSL_RUN_DIR)
		} catch {
			return []
		}
		const sockets: { path: string; mtimeMs: number }[] = []
		for (const name of names) {
			if (!/^\d+_interop$/.test(name)) continue
			const path = join(WSL_RUN_DIR, name)
			try {
				const stat = statSync(path)
				if (stat.isSocket()) sockets.push({ path, mtimeMs: stat.mtimeMs })
			} catch {
				// Gone between the listing and the stat: a session that just ended.
			}
		}
		return sockets
	},
}

/** Is this Linux kernel WSL's? The variables are absent under a systemd service. */
export function isWsl(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	probes: WslProbes = realWslProbes,
): boolean {
	if (platform !== 'linux') return false
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true
	return /microsoft|wsl/i.test(probes.readFile('/proc/sys/kernel/osrelease') ?? '')
}

/** The `[automount] root` of `/etc/wsl.conf`, with a trailing slash; `/mnt/` by default. */
export function parseWslMountRoot(wslConf: string | undefined): string {
	if (!wslConf) return DEFAULT_WSL_MOUNT_ROOT
	let section = ''
	for (const raw of wslConf.replace(/^﻿/, '').split(/\r?\n/)) {
		const line = raw.trim()
		if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
		const header = /^\[([^\]]+)\]$/.exec(line)
		if (header) {
			section = (header[1] ?? '').trim().toLowerCase()
			continue
		}
		const eq = line.indexOf('=')
		if (section !== 'automount' || eq <= 0) continue
		if (line.slice(0, eq).trim().toLowerCase() !== 'root') continue
		let value = line
			.slice(eq + 1)
			.replace(/\s[#;].*$/, '')
			.trim()
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
		if (!value.startsWith('/')) return DEFAULT_WSL_MOUNT_ROOT
		return value.endsWith('/') ? value : `${value}/`
	}
	return DEFAULT_WSL_MOUNT_ROOT
}

/** Windows PowerShell 5.1, absolute, as WSL sees it; `undefined` when it is not there. */
export function wslPowerShellPath(probes: WslProbes = realWslProbes): string | undefined {
	const path = `${parseWslMountRoot(probes.readFile('/etc/wsl.conf'))}${WSL_POWERSHELL_TAIL}`
	return probes.exists(path) ? path : undefined
}

/**
 * The interop socket to give a Windows program: `WSL_INTEROP` when it
 * exists; else `1_interop`, which WSL links for systemd to the distro's own
 * init and so lives as long as the distro; else the newest session's.
 */
export function wslInteropSocket(
	env: NodeJS.ProcessEnv,
	probes: WslProbes = realWslProbes,
): string | undefined {
	if (env.WSL_INTEROP && probes.exists(env.WSL_INTEROP)) return env.WSL_INTEROP
	const sockets = probes.interopSockets()
	const stable = sockets.find((socket) => socket.path === `${WSL_RUN_DIR}/1_interop`)
	if (stable) return stable.path
	return [...sockets].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path
}

/**
 * `WSLENV` with `entries` appended once each. An entry is a variable name
 * with optional flags (`NAME/p` translates a Linux path to a Windows one).
 */
export function mergeWslenv(existing: string | undefined, entries: readonly string[]): string {
	const present = (existing ?? '').split(':').filter((entry) => entry.length > 0)
	const names = new Set(present.map((entry) => entry.split('/')[0]))
	for (const entry of entries) {
		const name = entry.split('/')[0]
		if (names.has(name)) continue
		names.add(name)
		present.push(entry)
	}
	return present.join(':')
}

/**
 * The environment a Windows program started from WSL needs: the caller's,
 * with a working `WSL_INTEROP` (a systemd service has none, or a stale one)
 * and `forward` added to `WSLENV` so those variables cross the boundary.
 */
export function wslChildEnv(
	env: NodeJS.ProcessEnv,
	forward: readonly string[],
	probes: WslProbes = realWslProbes,
): NodeJS.ProcessEnv {
	const socket = wslInteropSocket(env, probes)
	return {
		...env,
		...(socket !== undefined ? { WSL_INTEROP: socket } : {}),
		WSLENV: mergeWslenv(env.WSLENV, forward),
	}
}
