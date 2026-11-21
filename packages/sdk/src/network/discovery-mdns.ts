/**
 * DNS-SD over multicast DNS for the Namzu network, with a codec for exactly the
 * subset it needs and no dependency (`node:dgram` only, injected).
 *
 * Service: `_namzu-net._tcp.local`. One instance per machine, labelled
 * `namzu-<8 random hex>` (random per process start), and a target host
 * `namzu-<same 8 hex>.local`. The TXT record carries two keys, `v=1` and
 * `n=<netId>`. Nothing else is announced: no hostname, no machine name, no
 * session title, no machine id. A stranger learns that "a Namzu network `n` has
 * a listener at this address and port" and nothing more.
 *
 * Subset of RFC 6762 / 6763 implemented:
 * - records PTR (12), SRV (33), TXT (16), A (1); AAAA (28) is decoded and
 *   ignored (phase 1 listens and announces on IPv4 only);
 * - questions for the service's PTR; answers carrying the whole instance;
 * - names on the wire without compression when sending, with compression
 *   pointers followed (bounded) when reading;
 * - TTL 0 on the PTR as a goodbye;
 * - UDP 5353 on 224.0.0.251, `reuseAddr`, one membership per private interface.
 *
 * Packets are capped at 1500 bytes in both directions; labels at 63 bytes and
 * names at 255; sections at 64 records. Anything malformed is dropped silently.
 *
 * @experimental
 */

import { randomBytes } from 'node:crypto'
import type { NetworkClock } from './clock.js'
import { isPrivateNetworkAddress } from './discovery.js'
import type {
	Advertisement,
	DiscoveredEndpoint,
	ListenAddress,
	NetworkDiscovery,
} from './discovery.js'

export const MDNS_PORT = 5353
export const MDNS_GROUP = '224.0.0.251'
export const SERVICE_NAME = '_namzu-net._tcp.local'
export const MAX_PACKET_BYTES = 1500
export const RECORD_TTL_SECONDS = 120
export const REQUERY_MS = 60_000

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const
const CLASS_IN = 1
const CACHE_FLUSH = 0x8000
const MAX_LABEL = 63
const MAX_NAME = 255
const MAX_RECORDS = 64

export type DnsData =
	| { readonly type: 'PTR'; readonly target: string }
	| { readonly type: 'SRV'; readonly port: number; readonly target: string }
	| { readonly type: 'TXT'; readonly entries: readonly string[] }
	| { readonly type: 'A'; readonly address: string }
	| { readonly type: 'AAAA' }

export interface DnsRecord {
	readonly name: string
	readonly ttl: number
	readonly data: DnsData
}

export interface DnsMessage {
	readonly questions: readonly { readonly name: string; readonly type: number }[]
	readonly answers: readonly DnsRecord[]
}

function encodeName(name: string): Buffer {
	const labels = name.split('.').filter((l) => l.length > 0)
	const parts: Buffer[] = []
	let total = 1
	for (const label of labels) {
		const bytes = Buffer.from(label, 'utf8')
		if (bytes.length === 0 || bytes.length > MAX_LABEL) throw new RangeError('label length')
		total += bytes.length + 1
		parts.push(Buffer.from([bytes.length]), bytes)
	}
	if (total > MAX_NAME) throw new RangeError('name length')
	parts.push(Buffer.from([0]))
	return Buffer.concat(parts)
}

function u16(n: number): Buffer {
	const b = Buffer.alloc(2)
	b.writeUInt16BE(n)
	return b
}

function u32(n: number): Buffer {
	const b = Buffer.alloc(4)
	b.writeUInt32BE(n)
	return b
}

function encodeRecord(record: DnsRecord): Buffer {
	let type: number
	let rdata: Buffer
	const d = record.data
	switch (d.type) {
		case 'PTR':
			type = TYPE.PTR
			rdata = encodeName(d.target)
			break
		case 'SRV':
			type = TYPE.SRV
			rdata = Buffer.concat([u16(0), u16(0), u16(d.port), encodeName(d.target)])
			break
		case 'TXT': {
			type = TYPE.TXT
			const parts = d.entries.map((e) => {
				const bytes = Buffer.from(e, 'utf8')
				if (bytes.length > 255) throw new RangeError('txt entry')
				return Buffer.concat([Buffer.from([bytes.length]), bytes])
			})
			rdata = parts.length > 0 ? Buffer.concat(parts) : Buffer.from([0])
			break
		}
		case 'A': {
			type = TYPE.A
			rdata = Buffer.from(d.address.split('.').map(Number))
			if (rdata.length !== 4) throw new RangeError('address')
			break
		}
		case 'AAAA':
			throw new RangeError('AAAA is not announced')
	}
	const cls = type === TYPE.PTR ? CLASS_IN : CLASS_IN | CACHE_FLUSH
	return Buffer.concat([
		encodeName(record.name),
		u16(type),
		u16(cls),
		u32(record.ttl),
		u16(rdata.length),
		rdata,
	])
}

function header(questions: number, answers: number, response: boolean): Buffer {
	return Buffer.concat([
		u16(0),
		u16(response ? 0x8400 : 0),
		u16(questions),
		u16(answers),
		u16(0),
		u16(0),
	])
}

/** A query for the Namzu service: one PTR question. */
export function encodeQuery(): Buffer {
	return Buffer.concat([
		header(1, 0, false),
		encodeName(SERVICE_NAME),
		u16(TYPE.PTR),
		u16(CLASS_IN),
	])
}

export interface InstanceAnnouncement {
	/** Random per process start: `namzu-<8 hex>`. */
	readonly instance: string
	readonly netId: string
	readonly port: number
	/** IPv4 addresses only. */
	readonly addresses: readonly string[]
	readonly ttl?: number
}

export function instanceFullName(instance: string): string {
	return `${instance}.${SERVICE_NAME}`
}

/** The records of one announcement: PTR, SRV, TXT and A. A TTL of 0 is the goodbye. */
export function announcementRecords(a: InstanceAnnouncement): DnsRecord[] {
	const ttl = a.ttl ?? RECORD_TTL_SECONDS
	const host = `${a.instance}.local`
	const full = instanceFullName(a.instance)
	return [
		{ name: SERVICE_NAME, ttl, data: { type: 'PTR', target: full } },
		{ name: full, ttl, data: { type: 'SRV', port: a.port, target: host } },
		{ name: full, ttl, data: { type: 'TXT', entries: ['v=1', `n=${a.netId}`] } },
		...a.addresses.map((address): DnsRecord => ({ name: host, ttl, data: { type: 'A', address } })),
	]
}

export function encodeAnnouncement(a: InstanceAnnouncement): Buffer {
	const records = announcementRecords(a)
	const out = Buffer.concat([header(0, records.length, true), ...records.map(encodeRecord)])
	if (out.length > MAX_PACKET_BYTES) throw new RangeError('announcement too large')
	return out
}

function readName(buf: Buffer, start: number): { name: string; next: number } | undefined {
	const labels: string[] = []
	let pos = start
	let next: number | undefined
	let jumps = 0
	let total = 0
	for (;;) {
		if (pos >= buf.length) return undefined
		const len = buf[pos] as number
		if (len === 0) {
			pos += 1
			break
		}
		if ((len & 0xc0) === 0xc0) {
			if (pos + 1 >= buf.length) return undefined
			const target = ((len & 0x3f) << 8) | (buf[pos + 1] as number)
			if (next === undefined) next = pos + 2
			if (++jumps > 8 || target >= buf.length) return undefined
			pos = target
			continue
		}
		if ((len & 0xc0) !== 0 || len > MAX_LABEL || pos + 1 + len > buf.length) return undefined
		total += len + 1
		if (total > MAX_NAME) return undefined
		labels.push(buf.toString('utf8', pos + 1, pos + 1 + len))
		pos += 1 + len
	}
	return { name: labels.join('.'), next: next ?? pos }
}

/** Decode a message; undefined for anything malformed or over the caps. Never throws. */
export function decodeMessage(buf: Buffer): DnsMessage | undefined {
	try {
		if (buf.length < 12 || buf.length > MAX_PACKET_BYTES) return undefined
		const qd = buf.readUInt16BE(4)
		const an = buf.readUInt16BE(6)
		if (qd > MAX_RECORDS || an > MAX_RECORDS) return undefined
		let pos = 12
		const questions: { name: string; type: number }[] = []
		for (let i = 0; i < qd; i++) {
			const n = readName(buf, pos)
			if (!n || n.next + 4 > buf.length) return undefined
			questions.push({ name: n.name, type: buf.readUInt16BE(n.next) })
			pos = n.next + 4
		}
		const answers: DnsRecord[] = []
		for (let i = 0; i < an; i++) {
			const n = readName(buf, pos)
			if (!n || n.next + 10 > buf.length) return undefined
			const type = buf.readUInt16BE(n.next)
			const ttl = buf.readUInt32BE(n.next + 4)
			const rdlen = buf.readUInt16BE(n.next + 8)
			const rstart = n.next + 10
			if (rstart + rdlen > buf.length) return undefined
			pos = rstart + rdlen
			let data: DnsData | undefined
			if (type === TYPE.PTR) {
				const t = readName(buf, rstart)
				if (t) data = { type: 'PTR', target: t.name }
			} else if (type === TYPE.SRV && rdlen >= 7) {
				const t = readName(buf, rstart + 6)
				if (t) data = { type: 'SRV', port: buf.readUInt16BE(rstart + 4), target: t.name }
			} else if (type === TYPE.TXT) {
				const entries: string[] = []
				let p = rstart
				while (p < rstart + rdlen) {
					const l = buf[p] as number
					if (p + 1 + l > rstart + rdlen) return undefined
					if (l > 0) entries.push(buf.toString('utf8', p + 1, p + 1 + l))
					p += 1 + l
				}
				data = { type: 'TXT', entries }
			} else if (type === TYPE.A && rdlen === 4) {
				data = { type: 'A', address: [...buf.subarray(rstart, rstart + 4)].join('.') }
			} else if (type === TYPE.AAAA) {
				data = { type: 'AAAA' }
			}
			if (data) answers.push({ name: n.name, ttl, data })
		}
		return { questions, answers }
	} catch {
		return undefined
	}
}

export interface FoundInstance {
	readonly instance: string
	readonly netId: string
	readonly port: number
	readonly addresses: readonly string[]
	readonly goodbye: boolean
}

/**
 * Join the PTR, SRV, TXT and A records of a message into the instances of the Namzu service they describe.
 * An instance is reported only when it carries a port, a valid `n` and at least one address (or is a goodbye).
 */
export function instancesFrom(message: DnsMessage): FoundInstance[] {
	const ptrs = message.answers.filter(
		(r) => r.name.toLowerCase() === SERVICE_NAME && r.data.type === 'PTR',
	)
	const out: FoundInstance[] = []
	for (const ptr of ptrs) {
		if (ptr.data.type !== 'PTR') continue
		const full = ptr.data.target
		const suffix = `.${SERVICE_NAME}`
		if (!full.toLowerCase().endsWith(suffix)) continue
		const instance = full.slice(0, full.length - suffix.length)
		const srv = message.answers.find((r) => r.name === full && r.data.type === 'SRV')
		const txt = message.answers.find((r) => r.name === full && r.data.type === 'TXT')
		if (!srv || srv.data.type !== 'SRV') continue
		let netId: string | undefined
		let version: string | undefined
		if (txt && txt.data.type === 'TXT') {
			for (const e of txt.data.entries) {
				if (e.startsWith('n=')) netId = e.slice(2)
				if (e.startsWith('v=')) version = e.slice(2)
			}
		}
		if (version !== '1' || netId === undefined || !/^[0-9a-f]{16}$/.test(netId)) continue
		const target = srv.data.target
		const addresses = message.answers
			.filter((r) => r.name === target && r.data.type === 'A')
			.map((r) => (r.data.type === 'A' ? r.data.address : ''))
			.filter((a) => a.length > 0)
		const goodbye = ptr.ttl === 0
		if (addresses.length === 0 && !goodbye) continue
		out.push({ instance, netId, port: srv.data.port, addresses, goodbye })
	}
	return out
}

/** The slice of `node:dgram` this module uses; tests supply a fake. */
export interface DgramSocketLike {
	on(
		event: 'message',
		listener: (msg: Buffer, rinfo: { address: string; port: number }) => void,
	): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
	bind(port: number, callback?: () => void): unknown
	addMembership(group: string, iface?: string): void
	setMulticastTTL?(ttl: number): void
	setMulticastLoopback?(flag: boolean): void
	send(msg: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void
	close(callback?: () => void): void
}

export interface DgramLike {
	createSocket(options: { type: 'udp4'; reuseAddr: boolean }): DgramSocketLike
}

export interface MdnsOptions {
	readonly dgram: DgramLike
	/** IPv4 addresses of the private interfaces to join and announce on. */
	readonly interfaces: () => readonly ListenAddress[]
	readonly clock: NetworkClock
	/** Injected for tests; defaults to `crypto.randomBytes`. */
	readonly randomHex?: () => string
}

const MAX_KNOWN_INSTANCES = 64

export function createMdnsDiscovery(options: MdnsOptions): NetworkDiscovery {
	const foundListeners = new Set<(e: DiscoveredEndpoint) => void>()
	const lostListeners = new Set<(e: DiscoveredEndpoint) => void>()
	const instance = `namzu-${(options.randomHex ?? (() => randomBytes(4).toString('hex')))()}`
	const known = new Map<string, DiscoveredEndpoint[]>()
	let socket: DgramSocketLike | undefined
	let ad: Advertisement | undefined
	let cancelRequery: (() => void) | undefined
	let closed = false

	const send = (packet: Buffer) => {
		socket?.send(packet, MDNS_PORT, MDNS_GROUP, () => undefined)
	}
	const announce = (ttl?: number) => {
		if (!ad) return
		const addresses = ad.addresses.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
		if (addresses.length === 0) return
		try {
			send(encodeAnnouncement({ instance, netId: ad.netId, port: ad.port, addresses, ttl }))
		} catch {
			// an over-large or malformed announcement is not sent
		}
	}
	const requery = () => {
		if (closed) return
		send(encodeQuery())
		cancelRequery = options.clock.setTimer(requery, REQUERY_MS)
	}

	const onMessage = (msg: Buffer, rinfo?: { address: string; port: number }) => {
		// A packet from a public or malformed source is dropped: only private networks are served.
		const source = rinfo?.address
		if (source !== undefined && !isPrivateNetworkAddress(source)) return
		const message = decodeMessage(msg)
		if (!message) return
		if (
			ad &&
			message.questions.some((q) => q.name.toLowerCase() === SERVICE_NAME && q.type === TYPE.PTR)
		)
			announce()
		for (const found of instancesFrom(message)) {
			if (found.instance === instance) continue
			// An announcement may only name addresses that are the sender's or on its subnet,
			// so a host cannot send every member to a third machine.
			const sameSubnet = (a: string) =>
				source === undefined ||
				a === source ||
				(isPrivateNetworkAddress(a) &&
					a.split('.').slice(0, 3).join('.') === source.split('.').slice(0, 3).join('.'))
			const addresses = found.addresses.filter(sameSubnet)
			if (addresses.length === 0 && !found.goodbye) continue
			if (!known.has(found.instance) && known.size >= MAX_KNOWN_INSTANCES) continue
			const endpoints = addresses.map(
				(host): DiscoveredEndpoint => ({ netId: found.netId, host, port: found.port }),
			)
			if (found.goodbye) {
				for (const e of known.get(found.instance) ?? []) for (const l of [...lostListeners]) l(e)
				known.delete(found.instance)
				continue
			}
			const before = known.get(found.instance) ?? []
			known.set(found.instance, endpoints)
			for (const e of endpoints) {
				if (before.some((b) => b.host === e.host && b.port === e.port && b.netId === e.netId))
					continue
				for (const l of [...foundListeners]) l(e)
			}
		}
	}

	return {
		start(advertisement) {
			if (closed) return
			// A later start only changes what is announced; the socket and its group stay.
			if (advertisement) ad = advertisement
			if (socket) {
				for (const i of options.interfaces()) {
					try {
						if (i.family === 4) socket.addMembership(MDNS_GROUP, i.address)
					} catch {
						// already a member on this interface, or no multicast there
					}
				}
				if (advertisement) announce()
				else if (ad) {
					// Browse only from now on: withdraw what was announced.
					announce(0)
					ad = undefined
				}
				return
			}
			const s = options.dgram.createSocket({ type: 'udp4', reuseAddr: true })
			socket = s
			s.on('error', () => undefined)
			s.on('message', onMessage)
			s.bind(MDNS_PORT, () => {
				try {
					s.setMulticastTTL?.(255)
					s.setMulticastLoopback?.(true)
					for (const i of options.interfaces())
						if (i.family === 4) s.addMembership(MDNS_GROUP, i.address)
				} catch {
					// no multicast on this interface; the manual address path still works
				}
				announce()
				requery()
			})
		},
		onFound(listener) {
			foundListeners.add(listener)
			return () => foundListeners.delete(listener)
		},
		onLost(listener) {
			lostListeners.add(listener)
			return () => lostListeners.delete(listener)
		},
		async close() {
			if (closed) return
			closed = true
			cancelRequery?.()
			announce(0)
			const s = socket
			socket = undefined
			await new Promise<void>((resolve) => {
				if (!s) return resolve()
				s.close(() => resolve())
			})
		},
	}
}
