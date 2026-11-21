import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { decideNetwork, networkSettings } from './policy.js'

const iface = (address: string, internal = false): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
	eth0: [
		{
			address,
			netmask: '255.255.255.0',
			family: address.includes(':') ? 'IPv6' : 'IPv4',
			mac: '00:00:00:00:00:00',
			internal,
			cidr: null,
		} as NetworkInterfaceInfo,
	],
})

const base = {
	settings: networkSettings(undefined),
	env: {},
	interactive: true,
	interfaces: () => iface('192.168.1.20'),
}

describe('whether this terminal runs the Namzu network', () => {
	it('is on by default for an interactive terminal on a private network', () => {
		expect(decideNetwork(base)).toEqual({ run: true, anyNetwork: false })
		for (const address of ['10.0.0.5', '172.16.4.2', '169.254.3.3', '100.64.1.1', 'fd00::1'])
			expect(decideNetwork({ ...base, interfaces: () => iface(address) }).run, address).toBe(true)
	})

	it('is off on a network it cannot tell is private, and says how to allow it', () => {
		for (const address of ['8.8.8.8', '172.32.0.1', '203.0.113.9']) {
			const decision = decideNetwork({ ...base, interfaces: () => iface(address) })
			expect(decision, address).toMatchObject({ run: false, reason: 'not-private' })
			expect((decision as { text: string }).text).toContain('namzu peers on --anyway')
		}
		// Loopback alone is not a network of other machines.
		expect(decideNetwork({ ...base, interfaces: () => iface('127.0.0.1', true) }).run).toBe(false)
	})

	it('runs on any network only when the person said true, and still only for an interactive terminal', () => {
		const anywhere = { ...base, settings: networkSettings({ enabled: true }) }
		expect(decideNetwork({ ...anywhere, interfaces: () => iface('8.8.8.8') })).toEqual({
			run: true,
			anyNetwork: true,
		})
		expect(decideNetwork({ ...anywhere, interactive: false })).toMatchObject({
			run: false,
			reason: 'headless',
		})
	})

	it('never runs for exec, scheduled runs or headless hosts, whatever the setting says', () => {
		for (const enabled of ['auto', true] as const)
			expect(
				decideNetwork({ ...base, settings: networkSettings({ enabled }), interactive: false }),
			).toMatchObject({ run: false, reason: 'headless' })
	})

	it('is off for good when the setting or the environment says so', () => {
		expect(decideNetwork({ ...base, settings: networkSettings({ enabled: false }) })).toMatchObject(
			{
				run: false,
				reason: 'disabled',
			},
		)
		for (const value of ['off', 'OFF', '0', 'false'])
			expect(decideNetwork({ ...base, env: { NAMZU_NETWORK: value } })).toMatchObject({
				run: false,
				reason: 'env-off',
			})
		// The hard stop wins over an explicit true.
		expect(
			decideNetwork({
				...base,
				settings: networkSettings({ enabled: true }),
				env: { NAMZU_NETWORK: 'off' },
			}).run,
		).toBe(false)
	})

	it('reads the settings with their defaults', () => {
		expect(networkSettings(undefined)).toEqual({
			enabled: 'auto',
			acceptMail: 'members',
			autoAdmit: 'trusted-networks',
		})
		expect(networkSettings({ acceptMail: 'hold', machineName: 'studio' })).toEqual({
			enabled: 'auto',
			acceptMail: 'hold',
			autoAdmit: 'trusted-networks',
			machineName: 'studio',
		})
		expect(networkSettings({ autoAdmit: 'never' }).autoAdmit).toBe('never')
	})
})
