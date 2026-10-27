import { describe, expect, it } from 'vitest'

import { proxyHost, readNetworkSettings, usesCustomNetwork } from './settings.js'

describe('readNetworkSettings', () => {
	it('is empty for an ordinary machine', () => {
		expect(readNetworkSettings({})).toEqual({ problems: [] })
		expect(usesCustomNetwork({})).toBe(false)
		expect(usesCustomNetwork({ HTTPS_PROXY: '  ', NO_PROXY: 'localhost' })).toBe(false)
	})

	it('reads either spelling, the upper-case one first', () => {
		expect(
			readNetworkSettings({
				HTTPS_PROXY: 'http://upper:3128',
				https_proxy: 'http://lower:3128',
				http_proxy: 'http://plain:8080',
			}),
		).toMatchObject({ httpsProxy: 'http://upper:3128', httpProxy: 'http://plain:8080' })
	})

	it('adds http:// to an address written without a scheme', () => {
		expect(readNetworkSettings({ HTTPS_PROXY: 'proxy.corp:3128' }).httpsProxy).toBe(
			'http://proxy.corp:3128',
		)
	})

	it('keeps credentials in the address it hands on, and never in a message', () => {
		const settings = readNetworkSettings({ HTTPS_PROXY: 'http://me:s3cret@proxy.corp:3128' })
		expect(settings.httpsProxy).toBe('http://me:s3cret@proxy.corp:3128')
		expect(proxyHost(settings.httpsProxy ?? '')).toBe('proxy.corp:3128')
		const bad = readNetworkSettings({ HTTPS_PROXY: 'socks5://me:s3cret@proxy.corp:1080' })
		expect(bad.httpsProxy).toBeUndefined()
		expect(JSON.stringify(bad.problems)).not.toContain('s3cret')
	})

	it.each([
		['socks5://proxy:1080', /socks5 proxy, which Namzu cannot use/],
		[':::', /not a proxy address Namzu can read/],
		['http://bad host:80', /not a proxy address Namzu can read/],
	])('ignores %s and says why, naming the variable and not the value', (value, message) => {
		const settings = readNetworkSettings({ HTTP_PROXY: value })
		expect(settings.httpProxy).toBeUndefined()
		expect(settings.problems).toHaveLength(1)
		expect(settings.problems[0]?.variable).toBe('HTTP_PROXY')
		expect(settings.problems[0]?.message).toMatch(message)
		expect(settings.problems[0]?.message).not.toContain(value)
		expect(usesCustomNetwork({ HTTP_PROXY: value })).toBe(true)
	})

	it('joins both NO_PROXY spellings, and a star in either skips the proxy everywhere', () => {
		expect(readNetworkSettings({ NO_PROXY: 'a.com', no_proxy: 'b.com' }).noProxy).toBe(
			'a.com,b.com',
		)
		expect(readNetworkSettings({ NO_PROXY: 'a.com', no_proxy: 'a.com' }).noProxy).toBe('a.com')
		expect(readNetworkSettings({ NO_PROXY: 'a.com', no_proxy: '*' }).noProxy).toBe('*')
	})

	it('reads the client certificate and its key', () => {
		expect(
			readNetworkSettings({ NAMZU_CLIENT_CERT: '/c.pem', NAMZU_CLIENT_KEY: '/k.pem' }),
		).toMatchObject({ clientCert: '/c.pem', clientKey: '/k.pem', problems: [] })
		expect(usesCustomNetwork({ NAMZU_CLIENT_CERT: '/c.pem' })).toBe(true)
	})

	it('says a key without a certificate sends nothing', () => {
		const settings = readNetworkSettings({ NAMZU_CLIENT_KEY: '/k.pem' })
		expect(settings.clientKey).toBeUndefined()
		expect(settings.problems[0]?.variable).toBe('NAMZU_CLIENT_KEY')
	})
})
