/**
 * Which local network is this machine on? A fingerprint of the subnet an
 * address belongs to plus the hardware address of that subnet's default
 * gateway, hashed. It answers "is this the same Wi-Fi or wire as last time"
 * well enough to remember that the person trusts it, and nothing more: it is
 * not a secret and not proof of anything.
 *
 * The gateway's hardware address is read without privileges and without
 * sending a packet of our own where the system keeps it already:
 * - Linux: `/proc/net/route` for the default route, `/proc/net/arp` for the
 *   neighbour table.
 * - macOS: `route -n get default`, then `arp -n <gateway>`.
 * - Windows: `Get-NetRoute` and `Get-NetNeighbor` through PowerShell.
 * None of them needs administrator rights. When the gateway or its hardware
 * address cannot be read, the network is UNKNOWN: it has no fingerprint, so it
 * is never trusted automatically. WSL2 in NAT mode sees only the Windows
 * host's virtual adapter as its gateway, so every WSL2 machine fingerprints
 * its own private network; mirrored networking removes that.
 *
 * Every reader is injected, so tests feed fixtures and never run a command.
 *
 * @experimental
 */

import { createHash } from 'node:crypto'
import type { NetworkInterfaceInfo } from 'node:os'
import type { NetworkClock } from './clock.js'

export interface Gateway {
	readonly ip: string
	/** Lowercase `aa:bb:cc:dd:ee:ff`. */
	readonly mac: string
}

export type GatewayReader = () => Promise<Gateway | undefined>

export type CommandRunner = (
	command: string,
	args: readonly string[],
) => Promise<string | undefined>

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

/** A hardware address worth hashing: six octets, not all zero, not broadcast. */
function usableMac(text: string): string | undefined {
	const mac = text.trim().toLowerCase().replace(/-/g, ':')
	if (!MAC.test(mac)) return undefined
	if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return undefined
	return mac
}

/** `0101A8C0` (little-endian hex as `/proc/net/route` writes it) to `192.168.1.1`. */
function hexToIPv4(hex: string): string | undefined {
	if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return undefined
	const n = Number.parseInt(hex, 16)
	return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.')
}

/** The default route of `/proc/net/route`: the gateway of the up route to 0.0.0.0/0 with the lowest metric. */
export function parseLinuxDefaultRoute(
	text: string,
): { readonly ip: string; readonly iface: string } | undefined {
	let best: { ip: string; iface: string; metric: number } | undefined
	for (const line of text.split('\n').slice(1)) {
		const cols = line.trim().split(/\s+/)
		if (cols.length < 8) continue
		const [iface, destination, gateway, flags, , , metric, mask] = cols as string[]
		if (destination !== '00000000' || mask !== '00000000') continue
		const f = Number.parseInt(flags ?? '0', 16)
		// RTF_UP (1) and RTF_GATEWAY (2)
		if ((f & 3) !== 3) continue
		const ip = hexToIPv4(gateway ?? '')
		if (!ip || ip === '0.0.0.0') continue
		const m = Number(metric)
		if (!best || m < best.metric) best = { ip, iface: iface ?? '', metric: m }
	}
	return best ? { ip: best.ip, iface: best.iface } : undefined
}

/** The hardware address of `ip` in `/proc/net/arp`; an entry that is not complete (flags 0x0) does not count. */
export function parseLinuxArp(text: string, ip: string): string | undefined {
	for (const line of text.split('\n').slice(1)) {
		const cols = line.trim().split(/\s+/)
		if (cols.length < 6 || cols[0] !== ip) continue
		if (Number.parseInt(cols[2] ?? '0', 16) === 0) continue
		return usableMac(cols[3] ?? '')
	}
	return undefined
}

/** `route -n get default` on macOS: the `gateway:` line. */
export function parseMacDefaultRoute(text: string): string | undefined {
	const match = /^\s*gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/m.exec(text)
	return match?.[1]
}

/** `arp -n 192.168.1.1` on macOS: `? (192.168.1.1) at aa:bb:... on en0 ifscope [ethernet]`. Macs drop leading zeros. */
export function parseMacArp(text: string, ip: string): string | undefined {
	const match = /\(([\d.]+)\) at ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i.exec(text)
	if (!match || match[1] !== ip) return undefined
	return usableMac(
		(match[2] as string)
			.split(':')
			.map((o) => o.padStart(2, '0'))
			.join(':'),
	)
}

/** PowerShell output of the one-line script below: `192.168.1.1 AA-BB-CC-DD-EE-FF`. */
export const WINDOWS_GATEWAY_SCRIPT =
	'$r = Get-NetRoute -DestinationPrefix \'0.0.0.0/0\' | Sort-Object RouteMetric | Select-Object -First 1; if ($r) { $n = Get-NetNeighbor -IPAddress $r.NextHop -ErrorAction SilentlyContinue | Where-Object { $_.LinkLayerAddress } | Select-Object -First 1; if ($n) { "$($r.NextHop) $($n.LinkLayerAddress)" } }'

export function parseWindowsGateway(text: string): Gateway | undefined {
	const match =
		/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9A-Fa-f]{2}(?:[-:][0-9A-Fa-f]{2}){5})\s*$/m.exec(text)
	if (!match) return undefined
	const mac = usableMac(match[2] as string)
	return mac ? { ip: match[1] as string, mac } : undefined
}

export interface SystemGatewayOptions {
	readonly platform?: NodeJS.Platform
	/** Read a small text file; undefined when it cannot be read. */
	readonly readText: (path: string) => Promise<string | undefined>
	/** Run a command with no shell and a short timeout; undefined when it fails. */
	readonly run: CommandRunner
}

/** The reader for this machine's system. Nothing here needs administrator rights. */
export function createSystemGatewayReader(options: SystemGatewayOptions): GatewayReader {
	const platform = options.platform ?? process.platform
	return async () => {
		if (platform === 'linux') {
			const route = await options.readText('/proc/net/route')
			const found = route ? parseLinuxDefaultRoute(route) : undefined
			if (!found) return undefined
			const arp = await options.readText('/proc/net/arp')
			const mac = arp ? parseLinuxArp(arp, found.ip) : undefined
			return mac ? { ip: found.ip, mac } : undefined
		}
		if (platform === 'darwin') {
			const route = await options.run('route', ['-n', 'get', 'default'])
			const ip = route ? parseMacDefaultRoute(route) : undefined
			if (!ip) return undefined
			const arp = await options.run('arp', ['-n', ip])
			const mac = arp ? parseMacArp(arp, ip) : undefined
			return mac ? { ip, mac } : undefined
		}
		if (platform === 'win32') {
			const out = await options.run('powershell.exe', [
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				WINDOWS_GATEWAY_SCRIPT,
			])
			return out ? parseWindowsGateway(out) : undefined
		}
		return undefined
	}
}

function ipv4ToInt(address: string): number | undefined {
	const parts = address.split('.')
	if (parts.length !== 4) return undefined
	let n = 0
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined
		n = n * 256 + Number(p)
	}
	return n
}

function prefixLength(netmask: string): number | undefined {
	const n = ipv4ToInt(netmask)
	if (n === undefined) return undefined
	let bits = 0
	for (let i = 31; i >= 0 && (n >>> i) & 1; i--) bits++
	return bits
}

/** The IPv4 subnet (`192.168.1.0/24`) of the interface address that contains `address`, if any. */
export function subnetOf(
	address: string,
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | undefined {
	const target = ipv4ToInt(address)
	if (target === undefined) return undefined
	for (const list of Object.values(interfaces)) {
		for (const info of list ?? []) {
			if (info.family !== 'IPv4') continue
			const bits = prefixLength(info.netmask)
			const base = ipv4ToInt(info.address)
			if (bits === undefined || base === undefined || bits === 0) continue
			const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0
			if ((target & mask) >>> 0 === (base & mask) >>> 0)
				return `${[24, 16, 8, 0].map((s) => ((base & mask) >>> s) & 0xff).join('.')}/${bits}`
		}
	}
	return undefined
}

/** The network id: 16 hex of sha256 over the subnet and the gateway's hardware address. */
export function networkFingerprint(subnet: string, gatewayMac: string): string {
	return createHash('sha256')
		.update(`namzu-net/lan/1\n${subnet}\n${gatewayMac}`)
		.digest('hex')
		.slice(0, 16)
}

export interface NetworkIdentityOptions {
	readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
	readonly gateway: GatewayReader
	readonly clock: NetworkClock
	/** How long a read of the gateway is reused. */
	readonly cacheMs?: number
}

/**
 * `identify(address)`: the fingerprint of the network `address` is on, or undefined when this machine is not
 * on that subnet, the gateway cannot be read, or the gateway is not on that subnet (so it is not that network's
 * gateway). Unknown means never trusted.
 */
export function createNetworkIdentity(
	options: NetworkIdentityOptions,
): (address: string) => Promise<string | undefined> {
	const cacheMs = options.cacheMs ?? 30_000
	let cached: { at: number; gateway: Gateway | undefined } | undefined
	return async (address) => {
		const interfaces = options.interfaces()
		const subnet = subnetOf(address, interfaces)
		if (!subnet) return undefined
		const now = options.clock.now()
		if (!cached || now - cached.at >= cacheMs) {
			cached = { at: now, gateway: await options.gateway().catch(() => undefined) }
		}
		const gateway = cached.gateway
		if (!gateway) return undefined
		if (subnetOf(gateway.ip, interfaces) !== subnet) return undefined
		return networkFingerprint(subnet, gateway.mac)
	}
}
