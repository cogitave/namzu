/**
 * How machines of one network find each other, behind an interface so tests
 * (and a host with its own mechanism) can supply a different one, and which
 * network interfaces the network may listen on.
 *
 * What is advertised is only an opaque network fingerprint and a port: no
 * hostname, no machine name, no session title. A stranger on the LAN learns
 * that "a Namzu network `n` has a listener here" and nothing else.
 *
 * @experimental
 */

import type { NetworkInterfaceInfo } from 'node:os'

export interface DiscoveredEndpoint {
	readonly netId: string
	readonly host: string
	readonly port: number
}

export interface Advertisement {
	readonly netId: string
	readonly port: number
	readonly addresses: readonly string[]
}

export interface NetworkDiscovery {
	/** Start browsing; with an advertisement, also announce it. `undefined` browses only. */
	start(advertisement: Advertisement | undefined): void
	onFound(listener: (endpoint: DiscoveredEndpoint) => void): () => void
	onLost(listener: (endpoint: DiscoveredEndpoint) => void): () => void
	close(): Promise<void>
}

function parseIPv4(address: string): [number, number, number, number] | undefined {
	const parts = address.split('.')
	if (parts.length !== 4) return undefined
	const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
	if (nums.some((n) => Number.isNaN(n) || n > 255)) return undefined
	return nums as [number, number, number, number]
}

/**
 * RFC 1918, link-local, CGNAT/overlay (100.64/10, e.g. Tailscale) and IPv6 ULA / link-local.
 * Loopback is not "private" here: it is never advertised and is only used in tests.
 */
export function isPrivateNetworkAddress(address: string): boolean {
	const v4 = parseIPv4(address)
	if (v4) {
		const [a, b] = v4
		return (
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		)
	}
	const lower = address.toLowerCase().split('%')[0] ?? ''
	if (!lower.includes(':')) return false
	const first = Number.parseInt(lower.split(':')[0] || '0', 16)
	if (Number.isNaN(first)) return false
	if ((first & 0xfe00) === 0xfc00) return true
	if ((first & 0xffc0) === 0xfe80) return true
	return false
}

export interface ListenAddress {
	/** The address as a person reads it. */
	readonly address: string
	/** What to bind to (link-local IPv6 needs its zone). */
	readonly bindHost: string
	readonly family: 4 | 6
}

export interface PrivateInterfaceOptions {
	readonly allowLoopback?: boolean
	/** Take every non-internal address, private or not (an explicit `network.enabled: true`). */
	readonly anyAddress?: boolean
}

/** The addresses the network may listen on, from `os.networkInterfaces()`. Never `0.0.0.0` or `::`. */
export function privateInterfaces(
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
	options: PrivateInterfaceOptions = {},
): ListenAddress[] {
	const out: ListenAddress[] = []
	for (const [name, list] of Object.entries(interfaces)) {
		for (const info of list ?? []) {
			const family = info.family === 'IPv6' ? 6 : 4
			if (info.internal) {
				if (options.allowLoopback && family === 4)
					out.push({ address: info.address, bindHost: info.address, family })
				continue
			}
			if (!options.anyAddress && !isPrivateNetworkAddress(info.address)) continue
			const linkLocal6 = family === 6 && /^fe[89ab]/i.test(info.address)
			out.push({
				address: info.address,
				bindHost:
					linkLocal6 && !info.address.includes('%') ? `${info.address}%${name}` : info.address,
				family,
			})
		}
	}
	return out
}

export interface FakeDiscovery extends NetworkDiscovery {
	readonly advertised: Advertisement | undefined
	readonly started: boolean
	emitFound(endpoint: DiscoveredEndpoint): void
	emitLost(endpoint: DiscoveredEndpoint): void
}

/** A discovery that does nothing by itself; the caller says what was found. For tests and for `peers add`. */
export function createFakeDiscovery(): FakeDiscovery {
	const found = new Set<(e: DiscoveredEndpoint) => void>()
	const lost = new Set<(e: DiscoveredEndpoint) => void>()
	let advertised: Advertisement | undefined
	let started = false
	return {
		get advertised() {
			return advertised
		},
		get started() {
			return started
		},
		start(ad) {
			started = true
			advertised = ad
		},
		onFound(l) {
			found.add(l)
			return () => found.delete(l)
		},
		onLost(l) {
			lost.add(l)
			return () => lost.delete(l)
		},
		async close() {
			started = false
			advertised = undefined
		},
		emitFound(e) {
			for (const l of [...found]) l(e)
		},
		emitLost(e) {
			for (const l of [...lost]) l(e)
		},
	}
}

export interface DiscoveryHub {
	/** One discovery per machine; an advertisement from any is found by every other that is browsing, now or later. */
	create(): NetworkDiscovery
}

/** An in-process "LAN": advertisements reach every other machine's discovery. Tests only. */
export function createDiscoveryHub(): DiscoveryHub {
	const members = new Set<{
		ad: Advertisement | undefined
		browsing: boolean
		found: Set<(e: DiscoveredEndpoint) => void>
		lost: Set<(e: DiscoveredEndpoint) => void>
	}>()
	const endpointsOf = (ad: Advertisement): DiscoveredEndpoint[] =>
		ad.addresses.map((host) => ({ netId: ad.netId, host, port: ad.port }))
	return {
		create() {
			const me = {
				ad: undefined as Advertisement | undefined,
				browsing: false,
				found: new Set<(e: DiscoveredEndpoint) => void>(),
				lost: new Set<(e: DiscoveredEndpoint) => void>(),
			}
			members.add(me)
			return {
				start(ad) {
					me.browsing = true
					me.ad = ad
					for (const other of members) {
						if (other === me) continue
						if (other.ad) for (const e of endpointsOf(other.ad)) for (const l of [...me.found]) l(e)
						if (ad)
							for (const e of endpointsOf(ad))
								for (const l of [...other.found]) if (other.browsing) l(e)
					}
				},
				onFound(l) {
					me.found.add(l)
					return () => me.found.delete(l)
				},
				onLost(l) {
					me.lost.add(l)
					return () => me.lost.delete(l)
				},
				async close() {
					const ad = me.ad
					me.ad = undefined
					me.browsing = false
					members.delete(me)
					if (ad)
						for (const other of members)
							for (const e of endpointsOf(ad)) for (const l of [...other.lost]) l(e)
				},
			}
		},
	}
}
