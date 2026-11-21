import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createManualClock } from './clock.js'
import {
	createNetworkIdentity,
	createSystemGatewayReader,
	networkFingerprint,
	parseLinuxArp,
	parseLinuxDefaultRoute,
	parseMacArp,
	parseMacDefaultRoute,
	parseWindowsGateway,
	subnetOf,
} from './fingerprint.js'

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
wlan0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0
`
const ARP = `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.1      0x1         0x2         AA:BB:CC:00:11:22     *        eth0
192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0
`

const iface = (address: string, netmask: string): NetworkInterfaceInfo => ({
	address,
	netmask,
	family: 'IPv4',
	mac: '00:00:00:00:00:00',
	internal: false,
	cidr: null,
})

describe('network fingerprint parsing', () => {
	it('reads the default gateway from a /proc/net/route fixture, lowest metric first', () => {
		expect(parseLinuxDefaultRoute(ROUTE)).toEqual({ ip: '192.168.1.1', iface: 'eth0' })
		expect(parseLinuxDefaultRoute('Iface\tDestination\n')).toBeUndefined()
		expect(parseLinuxDefaultRoute('')).toBeUndefined()
	})

	it('reads a complete neighbour entry and ignores an incomplete one', () => {
		expect(parseLinuxArp(ARP, '192.168.1.1')).toBe('aa:bb:cc:00:11:22')
		expect(parseLinuxArp(ARP, '192.168.1.9')).toBeUndefined()
		expect(parseLinuxArp(ARP, '10.0.0.1')).toBeUndefined()
	})

	it('reads the macOS and Windows outputs', () => {
		expect(
			parseMacDefaultRoute('   route to: default\n    gateway: 192.168.1.1\n  interface: en0\n'),
		).toBe('192.168.1.1')
		expect(
			parseMacArp('? (192.168.1.1) at a:bb:cc:0:11:22 on en0 ifscope [ethernet]', '192.168.1.1'),
		).toBe('0a:bb:cc:00:11:22')
		expect(parseMacArp('? (192.168.1.1) at (incomplete) on en0', '192.168.1.1')).toBeUndefined()
		expect(parseWindowsGateway('192.168.1.1 AA-BB-CC-00-11-22\r\n')).toEqual({
			ip: '192.168.1.1',
			mac: 'aa:bb:cc:00:11:22',
		})
		expect(parseWindowsGateway('')).toBeUndefined()
	})

	it('computes the subnet an address belongs to', () => {
		const interfaces = { eth0: [iface('192.168.1.20', '255.255.255.0')] }
		expect(subnetOf('192.168.1.77', interfaces)).toBe('192.168.1.0/24')
		expect(subnetOf('10.0.0.5', interfaces)).toBeUndefined()
	})
})

describe('the network identity', () => {
	const interfaces = () => ({ eth0: [iface('192.168.1.20', '255.255.255.0')] })
	const files: Record<string, string> = { '/proc/net/route': ROUTE, '/proc/net/arp': ARP }
	const reader = (override: Record<string, string | undefined> = {}) =>
		createSystemGatewayReader({
			platform: 'linux',
			readText: async (path) => ({ ...files, ...override })[path],
			run: async () => {
				throw new Error('a test must not run a command')
			},
		})

	it('is stable for one subnet and gateway, and differs with the gateway or the subnet', async () => {
		const clock = createManualClock()
		const identify = createNetworkIdentity({ interfaces, gateway: reader(), clock })
		const id = await identify('192.168.1.55')
		expect(id).toBe(networkFingerprint('192.168.1.0/24', 'aa:bb:cc:00:11:22'))
		expect(id).toMatch(/^[0-9a-f]{16}$/)
		const other = createNetworkIdentity({
			interfaces,
			gateway: reader({
				'/proc/net/arp': ARP.replace('AA:BB:CC:00:11:22', 'DE:AD:BE:EF:00:01'),
			}),
			clock,
		})
		expect(await other('192.168.1.55')).not.toBe(id)
	})

	it('is unknown when the gateway cannot be read', async () => {
		const clock = createManualClock()
		for (const files of <Record<string, string>[]>[
			{ '/proc/net/route': '' },
			{ '/proc/net/arp': 'IP address HW type Flags HW address Mask Device\n' },
		]) {
			const identify = createNetworkIdentity({ interfaces, gateway: reader(files), clock })
			expect(await identify('192.168.1.55')).toBeUndefined()
		}
		const unreadable = createSystemGatewayReader({
			platform: 'linux',
			readText: async () => undefined,
			run: async () => undefined,
		})
		expect(
			await createNetworkIdentity({ interfaces, gateway: unreadable, clock })('192.168.1.55'),
		).toBeUndefined()
	})

	it('is unknown for an address on no local subnet or when the gateway is on another subnet', async () => {
		const clock = createManualClock()
		const identify = createNetworkIdentity({ interfaces, gateway: reader(), clock })
		expect(await identify('10.9.9.9')).toBeUndefined()
		const stray = createNetworkIdentity({
			interfaces: () => ({ eth0: [iface('10.0.0.5', '255.255.255.0')] }),
			gateway: reader(),
			clock,
		})
		expect(await stray('10.0.0.9')).toBeUndefined()
	})

	it('reuses a read of the gateway until the cache expires', async () => {
		const clock = createManualClock()
		let reads = 0
		const identify = createNetworkIdentity({
			interfaces,
			clock,
			gateway: async () => {
				reads++
				return { ip: '192.168.1.1', mac: 'aa:bb:cc:00:11:22' }
			},
		})
		await identify('192.168.1.2')
		await identify('192.168.1.3')
		expect(reads).toBe(1)
		clock.advance(31_000)
		await identify('192.168.1.3')
		expect(reads).toBe(2)
	})

	it('uses the macOS and Windows commands through the injected runner only', async () => {
		const calls: string[] = []
		const mac = createSystemGatewayReader({
			platform: 'darwin',
			readText: async () => undefined,
			run: async (command, args) => {
				calls.push([command, ...args].join(' '))
				return command === 'route'
					? '    gateway: 192.168.1.1\n'
					: '? (192.168.1.1) at aa:bb:cc:0:11:22 on en0 ifscope [ethernet]'
			},
		})
		expect(await mac()).toEqual({ ip: '192.168.1.1', mac: 'aa:bb:cc:00:11:22' })
		expect(calls).toEqual(['route -n get default', 'arp -n 192.168.1.1'])
		const win = createSystemGatewayReader({
			platform: 'win32',
			readText: async () => undefined,
			run: async () => '192.168.1.1 AA-BB-CC-00-11-22',
		})
		expect(await win()).toEqual({ ip: '192.168.1.1', mac: 'aa:bb:cc:00:11:22' })
	})
})
