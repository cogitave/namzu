import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createManualClock } from './clock.js'
import {
	createDiscoveryHub,
	createFakeDiscovery,
	isPrivateNetworkAddress,
	privateInterfaces,
} from './discovery.js'

const info = (address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo =>
	({ address, family, internal, netmask: '', mac: '', cidr: null }) as NetworkInterfaceInfo

describe('isPrivateNetworkAddress', () => {
	it.each([
		['10.0.0.1', true],
		['172.16.0.1', true],
		['172.31.255.1', true],
		['172.32.0.1', false],
		['192.168.1.1', true],
		['169.254.1.1', true],
		['100.64.0.1', true],
		['100.128.0.1', false],
		['fd00::1', true],
		['fc00::1', true],
		['fe80::1', true],
		['fe80::1%eth0', true],
		['8.8.8.8', false],
		['2001:db8::1', false],
		['::1', false],
		['127.0.0.1', false],
		['not an address', false],
	])('%s -> %s', (address, expected) => {
		expect(isPrivateNetworkAddress(address)).toBe(expected)
	})
})

describe('privateInterfaces', () => {
	const os = {
		lo: [info('127.0.0.1', 'IPv4', true)],
		eth0: [info('192.168.1.20', 'IPv4'), info('fe80::abcd', 'IPv6'), info('8.8.4.4', 'IPv4')],
	}
	it('takes private addresses only, never loopback unless a test says so, and zones link-local IPv6', () => {
		const list = privateInterfaces(os)
		expect(list.map((a) => a.address)).toEqual(['192.168.1.20', 'fe80::abcd'])
		expect(list[1]?.bindHost).toBe('fe80::abcd%eth0')
		expect(privateInterfaces(os, { allowLoopback: true }).map((a) => a.address)).toContain(
			'127.0.0.1',
		)
	})
	it('takes a public address only when the person asked for any network, and never a wildcard', () => {
		expect(privateInterfaces(os, { anyAddress: true }).map((a) => a.address)).toContain('8.8.4.4')
		for (const a of privateInterfaces(os, { anyAddress: true, allowLoopback: true })) {
			expect(['0.0.0.0', '::']).not.toContain(a.bindHost)
		}
	})
	it('finds nothing on a machine with only a public address', () => {
		expect(privateInterfaces({ eth0: [info('203.0.113.5', 'IPv4')] })).toEqual([])
	})
})

describe('discovery doubles', () => {
	it('lets the caller say what was found or lost', () => {
		const d = createFakeDiscovery()
		const seen: string[] = []
		d.onFound((e) => seen.push(`found ${e.host}`))
		d.onLost((e) => seen.push(`lost ${e.host}`))
		d.start({ netId: 'a'.repeat(16), port: 1, addresses: ['10.0.0.1'] })
		d.emitFound({ netId: 'a'.repeat(16), host: '10.0.0.2', port: 2 })
		d.emitLost({ netId: 'a'.repeat(16), host: '10.0.0.2', port: 2 })
		expect(seen).toEqual(['found 10.0.0.2', 'lost 10.0.0.2'])
		expect(d.advertised).toEqual({ netId: 'a'.repeat(16), port: 1, addresses: ['10.0.0.1'] })
	})

	it('carries only a fingerprint, a port and addresses between machines', () => {
		const hub = createDiscoveryHub()
		const a = hub.create()
		const b = hub.create()
		const found: unknown[] = []
		b.onFound((e) => found.push(e))
		b.start(undefined)
		a.start({ netId: 'f'.repeat(16), port: 4000, addresses: ['10.1.1.1'] })
		expect(found).toEqual([{ netId: 'f'.repeat(16), host: '10.1.1.1', port: 4000 }])
	})
})

describe('manual clock', () => {
	it('runs timers in order, supports cancel, and moves only when told', () => {
		const clock = createManualClock(0)
		const order: number[] = []
		clock.setTimer(() => order.push(2), 20)
		clock.setTimer(() => order.push(1), 10)
		const cancel = clock.setTimer(() => order.push(3), 15)
		cancel()
		clock.advance(9)
		expect(order).toEqual([])
		clock.advance(11)
		expect(order).toEqual([1, 2])
		expect(clock.now()).toBe(20)
		expect(clock.pending).toBe(0)
	})
})
