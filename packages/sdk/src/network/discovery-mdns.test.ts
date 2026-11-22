import { hostname } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createManualClock } from './clock.js'
import {
	type DgramSocketLike,
	MAX_PACKET_BYTES,
	MDNS_GROUP,
	MDNS_PORT,
	REQUERY_MS,
	SERVICE_NAME,
	createMdnsDiscovery,
	decodeMessage,
	encodeAnnouncement,
	encodeQuery,
	instancesFrom,
} from './discovery-mdns.js'
import type { DiscoveredEndpoint, ListenAddress } from './discovery.js'

const NET = 'ab'.repeat(8)
const announcement = {
	instance: 'namzu-0a1b2c3d',
	netId: NET,
	port: 47310,
	addresses: ['192.168.1.20', '10.0.0.5'],
}

describe('mdns codec', () => {
	it('round-trips an announcement into one instance with its addresses', () => {
		const message = decodeMessage(encodeAnnouncement(announcement))
		expect(message).toBeDefined()
		const [found] = instancesFrom(message as NonNullable<typeof message>)
		expect(found).toEqual({
			instance: 'namzu-0a1b2c3d',
			netId: NET,
			port: 47310,
			addresses: ['192.168.1.20', '10.0.0.5'],
			goodbye: false,
		})
	})

	it('reads a goodbye (TTL 0) as one', () => {
		const message = decodeMessage(encodeAnnouncement({ ...announcement, ttl: 0 }))
		expect(instancesFrom(message as NonNullable<typeof message>)[0]?.goodbye).toBe(true)
	})

	it('round-trips the query', () => {
		expect(decodeMessage(encodeQuery())?.questions).toEqual([{ name: SERVICE_NAME, type: 12 }])
	})

	it('announces a fingerprint, a port and addresses and nothing a stranger could read as a name', () => {
		const packet = encodeAnnouncement(announcement)
		const text = packet.toString('latin1')
		for (const secret of [hostname(), 'studio', 'desk', 'session', 'Namzu network of']) {
			if (secret.length > 0) expect(text.toLowerCase()).not.toContain(secret.toLowerCase())
		}
		const message = decodeMessage(packet)
		const txt = message?.answers.find((r) => r.data.type === 'TXT')
		expect(txt?.data).toEqual({ type: 'TXT', entries: ['v=1', `n=${NET}`] })
		for (const r of message?.answers ?? []) {
			if (r.data.type === 'SRV') expect(r.data.target).toBe('namzu-0a1b2c3d.local')
		}
	})

	it('drops truncated, oversize, garbage and loop-compressed packets without throwing', () => {
		const good = encodeAnnouncement(announcement)
		expect(decodeMessage(good.subarray(0, good.length - 3))).toBeUndefined()
		expect(decodeMessage(Buffer.alloc(MAX_PACKET_BYTES + 1))).toBeUndefined()
		expect(decodeMessage(Buffer.from('not dns at all'))).toBeUndefined()
		expect(decodeMessage(Buffer.alloc(5))).toBeUndefined()
		const loop = Buffer.concat([
			Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
			Buffer.from([0xc0, 12]),
			Buffer.from([0, 12, 0, 1]),
		])
		expect(decodeMessage(loop)).toBeUndefined()
		const manyAnswers = Buffer.from(good)
		manyAnswers.writeUInt16BE(65535, 6)
		expect(decodeMessage(manyAnswers)).toBeUndefined()
	})

	it('ignores an instance with the wrong version, a bad network id or no address', () => {
		const ok = decodeMessage(encodeAnnouncement(announcement))
		const bad = (txt: string[]) => ({
			...(ok as NonNullable<typeof ok>),
			answers: (ok as NonNullable<typeof ok>).answers.map((r) =>
				r.data.type === 'TXT' ? { ...r, data: { type: 'TXT' as const, entries: txt } } : r,
			),
		})
		expect(instancesFrom(bad(['v=2', `n=${NET}`]))).toEqual([])
		expect(instancesFrom(bad(['v=1', 'n=XYZ']))).toEqual([])
		expect(instancesFrom(bad(['v=1']))).toEqual([])
		const noAddr = decodeMessage(encodeAnnouncement({ ...announcement, addresses: [] }))
		expect(instancesFrom(noAddr as NonNullable<typeof noAddr>)).toEqual([])
	})
})

class FakeSocket implements DgramSocketLike {
	readonly sent: { msg: Buffer; port: number; address: string }[] = []
	readonly memberships: string[] = []
	closed = false
	bound: number | undefined
	private onMessage: ((msg: Buffer, rinfo: { address: string; port: number }) => void) | undefined
	on(event: string, listener: (...args: never[]) => void): this {
		if (event === 'message') this.onMessage = listener as never
		return this
	}
	bind(port: number, callback?: () => void): void {
		this.bound = port
		callback?.()
	}
	addMembership(group: string, iface?: string): void {
		this.memberships.push(`${group}@${iface}`)
	}
	send(msg: Buffer, port: number, address: string, cb?: (e: Error | null) => void): void {
		this.sent.push({ msg, port, address })
		cb?.(null)
	}
	close(cb?: () => void): void {
		this.closed = true
		cb?.()
	}
	receive(msg: Buffer, from = '192.168.1.99'): void {
		this.onMessage?.(msg, { address: from, port: MDNS_PORT })
	}
}

const iface = (address: string): ListenAddress => ({ address, bindHost: address, family: 4 })

function setup() {
	const socket = new FakeSocket()
	const clock = createManualClock()
	const discovery = createMdnsDiscovery({
		dgram: { createSocket: () => socket },
		interfaces: () => [iface('192.168.1.20')],
		clock,
		randomHex: () => '11223344',
	})
	const found: DiscoveredEndpoint[] = []
	const lost: DiscoveredEndpoint[] = []
	discovery.onFound((e) => found.push(e))
	discovery.onLost((e) => lost.push(e))
	return { socket, clock, discovery, found, lost }
}

describe('mdns discovery', () => {
	it('a browse-only start followed by an advertised start announces from then on', () => {
		const { socket, discovery } = setup()
		discovery.start(undefined)
		const before = socket.sent.length
		discovery.start({ netId: NET, port: 5000, addresses: ['192.168.1.20'] })
		expect(socket.sent.length).toBe(before + 1)
		expect(
			decodeMessage((socket.sent.at(-1) as { msg: Buffer }).msg)?.answers.length,
		).toBeGreaterThan(0)
		discovery.start({ netId: NET, port: 5001, addresses: ['192.168.1.21'] })
		const last = decodeMessage((socket.sent.at(-1) as { msg: Buffer }).msg)
		expect(JSON.stringify(last?.answers)).toContain('192.168.1.21')
	})

	it('drops a packet from a public source and addresses outside the sender subnet', () => {
		const { socket, discovery, found } = setup()
		discovery.start(undefined)
		socket.receive(encodeAnnouncement(announcement), '8.8.8.8')
		socket.receive(encodeAnnouncement({ ...announcement, addresses: ['8.8.8.8'] }), '192.168.1.99')
		expect(found).toEqual([])
	})

	it('joins the group on each private interface, asks, announces, and asks again every minute', () => {
		const { socket, clock, discovery } = setup()
		discovery.start({ netId: NET, port: 5000, addresses: ['192.168.1.20'] })
		expect(socket.bound).toBe(MDNS_PORT)
		expect(socket.memberships).toEqual([`${MDNS_GROUP}@192.168.1.20`])
		expect(socket.sent.every((s) => s.address === MDNS_GROUP && s.port === MDNS_PORT)).toBe(true)
		const kinds = socket.sent.map((s) =>
			decodeMessage(s.msg)?.questions.length ? 'query' : 'announce',
		)
		expect(kinds).toEqual(['announce', 'query'])
		clock.advance(REQUERY_MS)
		expect(socket.sent).toHaveLength(3)
	})

	it('answers a query for the service with its announcement when it advertises, and stays silent when it only browses', () => {
		const a = setup()
		a.discovery.start({ netId: NET, port: 5000, addresses: ['192.168.1.20'] })
		const before = a.socket.sent.length
		a.socket.receive(encodeQuery())
		expect(a.socket.sent.length).toBe(before + 1)
		const b = setup()
		b.discovery.start(undefined)
		const quiet = b.socket.sent.length
		b.socket.receive(encodeQuery())
		expect(b.socket.sent.length).toBe(quiet)
	})

	it('reports a found endpoint once, ignores its own announcement, and reports a goodbye as lost', () => {
		const { socket, discovery, found, lost } = setup()
		discovery.start(undefined)
		socket.receive(encodeAnnouncement(announcement))
		socket.receive(encodeAnnouncement(announcement))
		expect(found).toEqual([{ netId: NET, host: '192.168.1.20', port: 47310 }])
		socket.receive(encodeAnnouncement({ ...announcement, instance: 'namzu-11223344' }))
		expect(found).toHaveLength(1)
		socket.receive(encodeAnnouncement({ ...announcement, ttl: 0 }))
		expect(lost).toHaveLength(1)
	})

	it('says goodbye on close and closes the socket', async () => {
		const { socket, discovery } = setup()
		discovery.start({ netId: NET, port: 5000, addresses: ['192.168.1.20'] })
		await discovery.close()
		const last = decodeMessage((socket.sent.at(-1) as { msg: Buffer }).msg)
		expect(last?.answers[0]?.ttl).toBe(0)
		expect(socket.closed).toBe(true)
	})

	it('does not announce an IPv6 or malformed address and survives garbage input', () => {
		const { socket, discovery } = setup()
		discovery.start({ netId: NET, port: 5000, addresses: ['fe80::1'] })
		expect(socket.sent.every((s) => decodeMessage(s.msg)?.answers.length === 0)).toBe(true)
		socket.receive(Buffer.from('garbage'))
	})
})
