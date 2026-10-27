import { describe, expect, it } from 'vitest'

import { builtInDoctorChecks } from '../index.js'
import { describeNetworkStatus, networkCheck } from '../network.js'

const readable = () => true
const unreadable = () => false

describe('the network row', () => {
	it('says requests go out directly when nothing is set', () => {
		expect(describeNetworkStatus({}, readable)).toEqual({
			status: 'pass',
			message: 'No proxy is set; requests go out directly.',
		})
	})

	it('names the proxy host and the hosts that skip it, never the credentials', () => {
		const result = describeNetworkStatus(
			{ HTTPS_PROXY: 'http://me:pw@proxy.corp:3128', NO_PROXY: 'localhost,.corp' },
			readable,
		)
		expect(result.status).toBe('pass')
		expect(result.message).toBe(
			'Requests go through the proxy at proxy.corp:3128, except for localhost,.corp.',
		)
		expect(result.message).not.toContain('pw')
	})

	it('says the extra authorities are trusted when the file can be read', () => {
		const result = describeNetworkStatus({ NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' }, readable)
		expect(result.status).toBe('pass')
		expect(result.message).toContain(
			'Extra certificate authorities are trusted from NODE_EXTRA_CA_CERTS.',
		)
	})

	it('warns when NODE_EXTRA_CA_CERTS points at a file nobody can read, which Node ignores', () => {
		const result = describeNetworkStatus({ NODE_EXTRA_CA_CERTS: '/missing.pem' }, unreadable)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('NODE_EXTRA_CA_CERTS points to a file that cannot be read')
		expect(result.remediation).toBeDefined()
	})

	it('warns about a proxy address it cannot use, without echoing the address', () => {
		const result = describeNetworkStatus({ HTTPS_PROXY: 'socks5://u:secret@proxy:1080' }, readable)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('HTTPS_PROXY names a socks5 proxy')
		expect(JSON.stringify(result)).not.toContain('secret')
	})

	it('warns about a client certificate file that cannot be read', () => {
		const result = describeNetworkStatus(
			{ NAMZU_CLIENT_CERT: '/c.pem', NAMZU_CLIENT_KEY: '/k.pem' },
			unreadable,
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('NAMZU_CLIENT_CERT points to a file that cannot be read.')
		expect(result.message).toContain('NAMZU_CLIENT_KEY points to a file that cannot be read.')
	})

	it('is one of the checks `namzu doctor` runs, in the runtime group', () => {
		expect(builtInDoctorChecks).toContain(networkCheck)
		expect(networkCheck).toMatchObject({ id: 'runtime.network', category: 'runtime' })
	})
})
