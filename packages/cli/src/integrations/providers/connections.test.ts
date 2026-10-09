import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	checkPastedKey,
	listProviderConnections,
	removeProviderKey,
	saveProviderKey,
	typedKeyProvider,
} from './connections.js'
import { apiKeysPath, listStoredApiKeyProviders, readStoredApiKey } from './credential-store.js'
import { discoverProviders } from './discover.js'

const SECRET = 'sk-fixture-secret-value-1234'
let home: string
const quiet = { skipProbes: true, skipKeychain: true, env: {} as NodeJS.ProcessEnv }

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-connections-'))
})
afterEach(() => {
	removeTempDir(home)
})

describe('pasted keys', () => {
	it('trims a key and refuses empty, spaced or oversized input', () => {
		expect(checkPastedKey(`  ${SECRET}\n`)).toBe(SECRET)
		expect(() => checkPastedKey('')).toThrow('Paste an API key.')
		expect(() => checkPastedKey(42)).toThrow('Paste an API key.')
		expect(() => checkPastedKey('two words')).toThrow('no spaces')
		expect(() => checkPastedKey('x'.repeat(5000))).toThrow('too long')
	})

	it('accepts only providers that take a typed key', () => {
		expect(typedKeyProvider('openai')).toBe('openai')
		expect(() => typedKeyProvider('codex')).toThrow('signed in')
		expect(() => typedKeyProvider('nonsense')).toThrow('listed providers')
		expect(() => typedKeyProvider('__proto__')).toThrow('listed providers')
	})
})

describe('saving and removing', () => {
	it('stores the key privately and discovery reads it back as a saved key', async () => {
		saveProviderKey('openai', SECRET, home)
		expect(readStoredApiKey('openai', home)).toBe(SECRET)
		if (platform() !== 'win32') expect(statSync(apiKeysPath(home)).mode & 0o077).toBe(0)
		const found = await discoverProviders({ ...quiet, home })
		const openai = found.find(({ entry }) => entry.id === 'openai')
		expect(openai?.apiKey).toBe(SECRET)
		expect(openai?.source).toEqual({ kind: 'stored-api-key', path: apiKeysPath(home) })
	})

	it('keeps other providers when one is removed, and deletes the file with the last', () => {
		saveProviderKey('openai', SECRET, home)
		saveProviderKey('openrouter', `${SECRET}-2`, home)
		removeProviderKey('openai', home)
		expect(listStoredApiKeyProviders(home)).toEqual(['openrouter'])
		removeProviderKey('openrouter', home)
		expect(listStoredApiKeyProviders(home)).toEqual([])
		expect(() => readFileSync(apiKeysPath(home))).toThrow()
	})

	it('lets an environment variable win over a saved key', async () => {
		saveProviderKey('openai', SECRET, home)
		const found = await discoverProviders({
			...quiet,
			home,
			env: { OPENAI_API_KEY: 'sk-from-env' },
		})
		const openai = found.find(({ entry }) => entry.id === 'openai')
		expect(openai?.apiKey).toBe('sk-from-env')
		expect(openai?.source.kind).toBe('env')
	})
})

describe('connection list', () => {
	it('lists connected providers first with how they are connected and never a key', async () => {
		saveProviderKey('openai', SECRET, home)
		const rows = await listProviderConnections({ ...quiet, home })
		expect(rows[0]).toMatchObject({
			id: 'openai',
			state: 'connected',
			how: 'saved-key',
			hasSavedKey: true,
			canSaveKey: true,
		})
		expect(JSON.stringify(rows)).not.toContain(SECRET)
		const anthropic = rows.find((row) => row.id === 'anthropic')
		expect(anthropic).toMatchObject({ state: 'not-connected', hasSavedKey: false })
		expect(anthropic?.help).toMatch(/Claude Code/)
		expect(rows.find((row) => row.id === 'codex')?.canSaveKey).toBe(false)
	})

	it('reports a key from the environment by variable name', async () => {
		const rows = await listProviderConnections({
			...quiet,
			home,
			env: { ANTHROPIC_API_KEY: SECRET },
		})
		expect(rows[0]).toMatchObject({
			id: 'anthropic',
			state: 'connected',
			how: 'environment',
			envName: 'ANTHROPIC_API_KEY',
			hasSavedKey: false,
		})
		expect(JSON.stringify(rows)).not.toContain(SECRET)
	})

	it('shows free Zen models as free, not as a connection', async () => {
		const rows = await listProviderConnections({ ...quiet, home })
		expect(rows.find((row) => row.id === 'zen')).toMatchObject({ state: 'free', how: 'free' })
		expect(rows.filter((row) => row.state === 'connected')).toEqual([])
	})
})
