import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider } from '../../integrations/providers/index.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

const SECRET = 'sk-fixture-secret-value-1234'
let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-acp-keys-'))
	vi.stubEnv('NAMZU_HOME', home)
	for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) vi.stubEnv(name, '')
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(home)
})

function runtimeWith(verify: AcpRuntimeDependencies['verifyKey']) {
	const probe = vi.fn(async () => ({
		preferences: null,
		detected: [] as DetectedProvider[],
		needsRepickReason: null,
	}))
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{ probe, verifyKey: verify } as unknown as AcpRuntimeDependencies,
	)
	return { runtime, probe }
}

it('saves a key, lists it without the secret, forgets the cached provider list and removes it', async () => {
	const { runtime, probe } = runtimeWith(undefined)
	await runtime.providerStatus()
	await runtime.providerStatus()
	expect(probe).toHaveBeenCalledTimes(1)

	expect(await runtime.saveProviderKey('openai', `  ${SECRET} `)).toEqual({ saved: true })
	const listed = await runtime.providerConnections()
	expect(listed.providers.find((row) => row.id === 'openai')).toMatchObject({
		state: 'connected',
		how: 'saved-key',
		hasSavedKey: true,
	})
	expect(JSON.stringify(listed)).not.toContain(SECRET)

	await runtime.providerStatus()
	expect(probe).toHaveBeenCalledTimes(2)

	expect(await runtime.removeProviderKey('openai')).toEqual({ removed: true })
	const after = await runtime.providerConnections()
	expect(after.providers.find((row) => row.id === 'openai')).toMatchObject({
		state: 'not-connected',
		hasSavedKey: false,
	})
	await runtime.providerStatus()
	expect(probe).toHaveBeenCalledTimes(3)
})

it('refuses a key for a provider that signs in, and never echoes the key in an error', async () => {
	const { runtime } = runtimeWith(undefined)
	await expect(runtime.saveProviderKey('codex', SECRET)).rejects.toThrow('signed in')
	await expect(runtime.saveProviderKey('openai', `${SECRET} extra`)).rejects.toSatisfy(
		(error: Error) => !error.message.includes(SECRET),
	)
})

it('tests a saved key with the provider check and maps the answer', async () => {
	const verify = vi.fn(async () => ({ kind: 'verified' as const }))
	const { runtime } = runtimeWith(verify)
	expect(await runtime.testProvider('openai')).toEqual({ status: 'missing' })
	await runtime.saveProviderKey('openai', SECRET)
	expect(await runtime.testProvider('openai')).toEqual({ status: 'ok' })
	expect(verify).toHaveBeenCalledTimes(1)
	verify.mockResolvedValueOnce({ kind: 'rejected' as never, reason: 'nope' } as never)
	expect(await runtime.testProvider('openai')).toEqual({ status: 'rejected' })
	verify.mockResolvedValueOnce({ kind: 'unverifiable' } as never)
	expect(await runtime.testProvider('openai')).toEqual({ status: 'unchecked' })
})
