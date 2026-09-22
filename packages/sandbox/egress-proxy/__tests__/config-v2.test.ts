import { describe, expect, it } from 'vitest'

import { parseProxyConfigV2, readProxyConfig, startEgressProxy } from '../server.mjs'

/**
 * The V2 configuration (`NAMZU_EGRESS_PROXY_CONFIG_V2`), which adds port rules.
 *
 * Imported, so every refusal throws rather than exiting; `server.test.js`
 * covers the process-level behaviour of the V1 path.
 */

const base = { port: 2025, allowedHosts: ['api.example.com'], credentials: [] }

describe('parseProxyConfigV2', () => {
	it('accepts rules with and without ports', () => {
		const parsed = parseProxyConfigV2(
			JSON.stringify({
				...base,
				hostPorts: [{ host: 'api.example.com', ports: [443] }, { host: '.example.org' }],
			}),
		)
		expect(parsed.hostPorts).toEqual([
			{ host: 'api.example.com', ports: [443] },
			{ host: '.example.org' },
		])
	})

	it.each([
		[[{ host: 'a.example.com', ports: [443.5] }], /hostPorts\[0\]\.ports\[0\] must be an integer/],
		[[{ host: 'a.example.com', ports: ['443'] }], /hostPorts\[0\]\.ports\[0\] must be an integer/],
		[[{ host: 'a.example.com', ports: [0] }], /must be an integer between 1 and 65535/],
		[[{ host: 'a.example.com', ports: [443, 443] }], /repeats port 443/],
		[[{ host: 'a.example.com', ports: [] }], /must be a non-empty array/],
		[[{ host: '' }], /hostPorts\[0\]\.host must be a non-empty string/],
		[
			[{ host: 'a.example.com', port: 443 }],
			/hostPorts\[0\]\.port is not a field this proxy reads/,
		],
		['not a list', /hostPorts must be an array/],
	])('refuses hostPorts %j', (hostPorts, message) => {
		expect(() => parseProxyConfigV2(JSON.stringify({ ...base, hostPorts }))).toThrow(message)
	})

	it('refuses a missing hostPorts, which is what V2 is for', () => {
		expect(() => parseProxyConfigV2(JSON.stringify(base))).toThrow(/hostPorts must be an array/)
	})

	it('refuses an unknown field rather than ignoring it, naming only the key', () => {
		expect(() =>
			parseProxyConfigV2(JSON.stringify({ ...base, hostPorts: [], denyPorts: ['secret-ish'] })),
		).toThrow(/NAMZU_EGRESS_PROXY_CONFIG_V2\.denyPorts is not a field this proxy reads/)
		try {
			parseProxyConfigV2(JSON.stringify({ ...base, hostPorts: [], denyPorts: ['secret-ish'] }))
		} catch (error) {
			expect(String(error)).not.toContain('secret-ish')
		}
	})

	it('still validates the V1 fields, under the V2 name', () => {
		expect(() =>
			parseProxyConfigV2(JSON.stringify({ ...base, port: 70000, hostPorts: [] })),
		).toThrow(/NAMZU_EGRESS_PROXY_CONFIG_V2\.port must be an integer/)
	})
})

describe('readProxyConfig', () => {
	it('reads V2 when it is set, and never merges V1 into it', () => {
		const config = readProxyConfig({
			NAMZU_EGRESS_PROXY_CONFIG: JSON.stringify({ ...base, allowedHosts: ['v1.example.com'] }),
			NAMZU_EGRESS_PROXY_CONFIG_V2: JSON.stringify({ ...base, hostPorts: [] }),
		})
		expect(config.allowedHosts).toEqual(['api.example.com'])
		expect(config.hostPorts).toEqual([])
	})

	it('reads V1 when V2 is absent, with no hostPorts', () => {
		const config = readProxyConfig({ NAMZU_EGRESS_PROXY_CONFIG: JSON.stringify(base) })
		expect(config.hostPorts).toBeUndefined()
	})

	it('refuses when neither is set', () => {
		expect(() => readProxyConfig({})).toThrow(/NAMZU_EGRESS_PROXY_CONFIG is not set/)
	})
})

describe('startEgressProxy with port rules', () => {
	function loader(record: { options?: Record<string, unknown> }, withHelper = true) {
		return async () => ({
			EgressProxy: class {
				constructor(options: Record<string, unknown>) {
					record.options = options
				}
				async listen(port: number) {
					return { port, url: '', setAllowedHosts: () => {}, close: async () => {} }
				}
			},
			...(withHelper
				? {
						egressPortsForRules: (rules: { host: string; ports?: number[] }[]) => (host: string) =>
							rules.find((rule) => rule.host === host)?.ports ?? 'any',
					}
				: {}),
		})
	}

	it('hands the boundary a port check built by the module’s own helper', async () => {
		const record: { options?: Record<string, unknown> } = {}
		const config = parseProxyConfigV2(
			JSON.stringify({ ...base, hostPorts: [{ host: 'api.example.com', ports: [443] }] }),
		)
		const running = await startEgressProxy(config, loader(record))
		await running.close()
		const allowedPorts = record.options?.allowedPorts as (host: string) => unknown
		expect(allowedPorts('api.example.com')).toEqual([443])
	})

	it('passes no port check for a V1 configuration', async () => {
		const record: { options?: Record<string, unknown> } = {}
		const running = await startEgressProxy(
			readProxyConfig({ NAMZU_EGRESS_PROXY_CONFIG: JSON.stringify(base) }),
			loader(record),
		)
		await running.close()
		expect(Object.keys(record.options ?? {})).not.toContain('allowedPorts')
	})

	it('refuses port rules when the module cannot enforce them', async () => {
		const config = parseProxyConfigV2(
			JSON.stringify({ ...base, hostPorts: [{ host: 'api.example.com', ports: [443] }] }),
		)
		await expect(startEgressProxy(config, loader({}, false))).rejects.toThrow(
			/has no egressPortsForRules/,
		)
	})
})
