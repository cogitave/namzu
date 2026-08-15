import { afterEach, describe, expect, it } from 'vitest'

import type { TenantId } from '../types/ids/index.js'
import { jsonLinesSink } from '../utils/log/index.js'
import { __resetProcessSinkForTests, installProcessSink } from '../utils/log/process-sink.js'

import { InMemoryCredentialVault } from './InMemoryCredentialVault.js'

const tenant = 'tnt_acme' as TenantId
const connector = 'conn_x' as never

/**
 * `store()` and `revoke()` used to write caller-supplied text straight into
 * the log MESSAGE. `label` (and, per the same interpolation, the tenant id)
 * is text the CALLER chose, not text the vault authored — a hostile value
 * embedding its own fake log line forges a second record downstream
 * (CWE-117). This pins the fix: both bodies are constant strings now, the
 * variable text lives in namespaced attributes instead.
 */
function captureSink() {
	const chunks: string[] = []
	const stream = {
		write: (chunk: string) => {
			chunks.push(String(chunk))
			return true
		},
	} as unknown as NodeJS.WritableStream
	return { chunks, stream }
}

describe('InMemoryCredentialVault — a hostile label cannot forge a second log line', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it('store(): confines the caller-supplied label to an attribute, one JSON line', async () => {
		const { chunks, stream } = captureSink()
		// Must install BEFORE constructing the vault: the constructor resolves
		// `getRootLogger()` once and binds `this.log` to whatever destination
		// was in effect at that moment — installing afterwards would leave it
		// pointed at the (test-silenced) legacy fallback instead.
		installProcessSink(jsonLinesSink(stream), 'info')

		const hostileLabel = 'x\n[2026-01-01T00:00:00Z] [ERROR] [audit] forged'
		const vault = new InMemoryCredentialVault()

		await vault.store(tenant, connector, hostileLabel, { type: 'apiKey', apiKey: 's' } as never)

		const lines = chunks.join('').trim().split('\n')
		expect(lines).toHaveLength(1)

		const record = JSON.parse(lines[0] ?? '')
		expect(record.body).toBe('Credential stored')
		expect(record.attributes['namzu.credential.label']).toBe(hostileLabel)
	})

	it('store(): also confines a hostile tenant id to an attribute', async () => {
		const { chunks, stream } = captureSink()
		installProcessSink(jsonLinesSink(stream), 'info')

		const hostileTenant = 'tnt_x\n[2026-01-01T00:00:00Z] [ERROR] [audit] forged' as TenantId
		const vault = new InMemoryCredentialVault()

		await vault.store(hostileTenant, connector, 'k', { type: 'apiKey', apiKey: 's' } as never)

		const lines = chunks.join('').trim().split('\n')
		expect(lines).toHaveLength(1)

		const record = JSON.parse(lines[0] ?? '')
		expect(record.attributes['namzu.tenant.id']).toBe(hostileTenant)
	})

	it('revoke(): logs a constant body with the credential id as an attribute, not interpolated', async () => {
		const { chunks, stream } = captureSink()
		installProcessSink(jsonLinesSink(stream), 'info')

		const vault = new InMemoryCredentialVault()
		const ref = await vault.store(tenant, connector, 'k', { type: 'apiKey', apiKey: 's' } as never)
		await vault.revoke(ref.id)

		const records = chunks
			.join('')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		const revoked = records.find((record) => record.body === 'Credential revoked')

		expect(revoked).toBeDefined()
		expect(revoked.attributes['namzu.credential.id']).toBe(ref.id)
	})
})
