import { describe, expect, it } from 'vitest'

import { createProbeRegistry } from '../probe/registry.js'
import type { AgentBusEvent } from '../types/bus/index.js'
import type { CredentialId, TenantId } from '../types/ids/index.js'

import { InMemoryCredentialVault } from './InMemoryCredentialVault.js'
import { wrapVaultWithProbes } from './instrumentation.js'

const tenant = 'tnt_acme' as TenantId
const connector = 'conn_x' as never

describe('wrapVaultWithProbes', () => {
	it('emits vault_lookup with found:true when retrieve hits', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const inner = new InMemoryCredentialVault()
		const ref = await inner.store(tenant, connector, 'k', { type: 'apiKey', apiKey: 's' } as never)
		const wrapped = wrapVaultWithProbes(inner, { probes: reg, vaultId: 'in-memory' })

		const result = await wrapped.retrieve(ref.id)
		expect(result).toBeDefined()
		expect(seen.length).toBe(1)
		const event = seen[0] as AgentBusEvent & { type: 'vault_lookup' }
		expect(event.type).toBe('vault_lookup')
		expect(event.found).toBe(true)
		expect(event.vaultId).toBe('in-memory')
		expect(event.credentialId).toBe(ref.id)
	})

	it('emits vault_lookup with found:false when retrieve misses', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const wrapped = wrapVaultWithProbes(new InMemoryCredentialVault(), {
			probes: reg,
			vaultId: 'in-memory',
		})
		const missing = 'cred_missing' as CredentialId
		const result = await wrapped.retrieve(missing)

		expect(result).toBeUndefined()
		expect(seen.length).toBe(1)
		const event = seen[0] as AgentBusEvent & { type: 'vault_lookup' }
		expect(event.found).toBe(false)
		expect(event.credentialId).toBe(missing)
	})

	it('does not emit on store/revoke/list — retrieve is the audit point', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const wrapped = wrapVaultWithProbes(new InMemoryCredentialVault(), { probes: reg })
		const ref = await wrapped.store(tenant, connector, 'k', {
			type: 'apiKey',
			apiKey: 's',
		} as never)
		await wrapped.list(tenant)
		await wrapped.revoke(ref.id)
		expect(seen.length).toBe(0)
	})

	it('does not leak the secret value in the emitted event', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const inner = new InMemoryCredentialVault()
		const ref = await inner.store(tenant, connector, 'k', {
			type: 'apiKey',
			apiKey: 'super-secret-value',
		} as never)
		const wrapped = wrapVaultWithProbes(inner, { probes: reg })
		await wrapped.retrieve(ref.id)

		const event = seen[0]
		const serialized = JSON.stringify(event)
		expect(serialized).not.toContain('super-secret-value')
	})

	it('falls back to constructor.name as vaultId when not specified', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const inner = new InMemoryCredentialVault()
		const ref = await inner.store(tenant, connector, 'k', { type: 'apiKey', apiKey: 's' } as never)
		const wrapped = wrapVaultWithProbes(inner, { probes: reg })
		await wrapped.retrieve(ref.id)

		const event = seen[0] as AgentBusEvent & { type: 'vault_lookup' }
		expect(event.vaultId).toBe('InMemoryCredentialVault')
	})
})
