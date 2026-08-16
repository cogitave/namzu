import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentBusEvent, probe, wrapCredentialProviderWithProbes } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	clearRegisteredCredentialProviders,
	registerCredentialProvider,
	vaultRegisteredCheck,
} from '../../../doctor/checks/vault.js'
import { FileCredentialProvider, SUBSCRIPTION_CREDENTIAL_REF } from '../credential-provider.js'
import { credentialsPath } from '../credential-store.js'

/**
 * A credential could turn over and nothing could see it.
 *
 * The bus carried `vault_lookup` and no change event, so no probe
 * subscriber could observe a rotation — and the doctor's vault check
 * returned `skipped` unconditionally with "no vault auto-discovery in v1",
 * an answer that was the same on every machine forever.
 *
 * The value never travels. A change event exists to be logged, forwarded
 * and retained, which is exactly what a credential must not be.
 */

const FAKE = 'sk-fake-do-not-leak-0123456789'
let home: string
let seen: AgentBusEvent[]
let unsubscribe: () => void

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-rotation-'))
	seen = []
	unsubscribe = probe.on('vault_credential_changed', (event) => {
		seen.push(event as AgentBusEvent)
	})
	clearRegisteredCredentialProviders()
})

afterEach(() => {
	unsubscribe()
	clearRegisteredCredentialProviders()
})

const provider = () =>
	wrapCredentialProviderWithProbes(new FileCredentialProvider({ home }), { source: 'file' })

describe('a credential turning over is observable', () => {
	it('announces a first write as `set`, not `rotated`', async () => {
		// The distinction a reader actually wants: a first write is
		// configuration, a replacement is a credential turning over.
		await provider().set(SUBSCRIPTION_CREDENTIAL_REF, FAKE)

		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ type: 'vault_credential_changed', kind: 'set' })
	})

	it('announces a replacement as `rotated`, exactly once', async () => {
		const p = provider()
		await p.set(SUBSCRIPTION_CREDENTIAL_REF, 'sk-original')
		seen.length = 0

		await p.set(SUBSCRIPTION_CREDENTIAL_REF, FAKE)

		// Exactly one. Two dispatches read as two rotations, and a reader
		// counting them would report a turnover that never happened.
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ kind: 'rotated' })
	})

	it('carries no part of the secret', async () => {
		await provider().set(SUBSCRIPTION_CREDENTIAL_REF, FAKE)

		expect(JSON.stringify(seen)).not.toContain(FAKE)
		expect(JSON.stringify(seen)).not.toContain(FAKE.slice(0, 12))
	})

	it('announces an unset, and reports the credential gone', async () => {
		const p = provider()
		await p.set(SUBSCRIPTION_CREDENTIAL_REF, FAKE)
		seen.length = 0

		await p.unset(SUBSCRIPTION_CREDENTIAL_REF)

		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ kind: 'unset' })
		expect((await p.describe(SUBSCRIPTION_CREDENTIAL_REF)).configured).toBe(false)
	})

	it('says nothing when the write refused', async () => {
		// An event for a write that changed nothing sends a reader chasing a
		// rotation that never happened.
		const p = provider()

		await expect(p.set('some.other.ref', FAKE)).rejects.toThrow()

		expect(seen).toHaveLength(0)
	})
})

describe('the write proves its own protection', () => {
	it('round-trips through the real file at 0600', async () => {
		// Not declared — read back. The store owns this discipline and the
		// adapter adds no file logic of its own, so this is asserting the
		// guarantee survived the wrapping rather than restating it.
		const p = new FileCredentialProvider({ home })
		await p.set(SUBSCRIPTION_CREDENTIAL_REF, FAKE)

		expect(await p.resolve(SUBSCRIPTION_CREDENTIAL_REF)).toMatchObject({ value: FAKE })
		if (process.platform !== 'win32') {
			expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600)
		}
	})

	it('reports itself writable, and only for the ref it holds', async () => {
		const p = new FileCredentialProvider({ home })

		expect((await p.describe(SUBSCRIPTION_CREDENTIAL_REF)).writable).toBe(true)
		// A description that claimed writable for a name `set` refuses would
		// disagree with the thing it describes.
		expect((await p.describe('some.other.ref')).writable).toBe(false)
	})
})

describe('the doctor can answer about credentials', () => {
	it('skips only when nothing is registered', async () => {
		const result = await vaultRegisteredCheck.run({} as never)

		expect(result.status).toBe('skipped')
		expect(result.message).toMatch(/nothing to report/i)
	})

	it('answers about a registered provider', async () => {
		// The branch the old unconditional `skipped` could never reach, which
		// is what made it a check that cannot fail.
		const p = new FileCredentialProvider({ home })
		await p.set(SUBSCRIPTION_CREDENTIAL_REF, FAKE)
		registerCredentialProvider(p, 'file', [SUBSCRIPTION_CREDENTIAL_REF])

		const result = await vaultRegisteredCheck.run({} as never)

		expect(result.status).toBe('pass')
		expect(result.message).toContain('configured')
		expect(result.message).toContain('writable')
	})

	it('warns rather than passing when a provider holds nothing', async () => {
		// A real state — an operator who has not logged in — and one the
		// doctor should describe rather than complain about or hide.
		registerCredentialProvider(new FileCredentialProvider({ home }), 'file', [
			SUBSCRIPTION_CREDENTIAL_REF,
		])

		const result = await vaultRegisteredCheck.run({} as never)

		expect(result.status).toBe('warn')
		expect(result.message).toContain('not set')
	})

	it('never puts the value in its report', async () => {
		// This output is what an operator pastes into an issue.
		const p = new FileCredentialProvider({ home })
		await p.set(SUBSCRIPTION_CREDENTIAL_REF, FAKE)
		registerCredentialProvider(p, 'file', [SUBSCRIPTION_CREDENTIAL_REF])

		const result = await vaultRegisteredCheck.run({} as never)

		expect(result.message).not.toContain(FAKE)
	})
})
