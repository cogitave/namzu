import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountRegistry } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	apiKeyLogoutTarget,
	apiKeysPath,
	clearAllStoredApiKeys,
	clearStoredApiKey,
	discoverProviders,
	listStoredApiKeyProviders,
	migrateAccountKeys,
	readStoredApiKey,
	writeStoredApiKey,
	writeStoredGeminiApiKey,
} from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { keyMigrationMarkerPath } from '../../integrations/providers/key-migration.js'
import { describeDisposition } from '../credential-entry.js'
import { keepAccountKeyForStartup, saveTypedKey } from '../typed-key-save.js'

const KEY = 'sk-test-0000000000000000000000000000'
const OTHER = 'sk-test-1111111111111111111111111111'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-keypersist-'))
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
})

const discover = (env: NodeJS.ProcessEnv = {}) =>
	discoverProviders({ home, env, skipProbes: true, skipKeychain: true, windowsHome: null })

describe('a typed key is kept for the next start', () => {
	it('is not asked for again after it was entered once (the reported case)', async () => {
		// Before: DeepSeek is not detected on a clean home.
		expect((await discover()).find((d) => d.entry.id === 'deepseek')).toBeUndefined()

		// The TUI saves the key after the session opens ...
		const saved = saveTypedKey('deepseek', KEY, home)
		expect(saved).toEqual({ kind: 'saved', path: apiKeysPath(home) })

		// ... and a fresh start (a new discovery) finds it without a prompt.
		const next = (await discover()).find((d) => d.entry.id === 'deepseek')
		expect(next?.apiKey).toBe(KEY)
		expect(next?.source.kind).toBe('stored-api-key')
	})

	it.each(['openai', 'openrouter', 'anthropic', 'deepseek'] as const)(
		'keeps a %s key too',
		async (id) => {
			saveTypedKey(id, KEY, home)
			expect((await discover()).find((d) => d.entry.id === id)?.apiKey).toBe(KEY)
		},
	)

	it('keeps Gemini where startup already reads it', async () => {
		saveTypedKey('google', KEY, home)
		expect((await discover()).find((d) => d.entry.id === 'google')?.apiKey).toBe(KEY)
	})

	it.skipIf(process.platform === 'win32')('writes the file readable by its owner only', () => {
		saveTypedKey('deepseek', KEY, home)
		expect(statSync(apiKeysPath(home)).mode & 0o777).toBe(0o600)
		const doc = JSON.parse(readFileSync(apiKeysPath(home), 'utf8'))
		expect(doc).toEqual({ version: 1, keys: { deepseek: KEY } })
	})

	it('keeps other providers when one more is saved', () => {
		saveTypedKey('deepseek', KEY, home)
		saveTypedKey('openai', OTHER, home)
		expect(listStoredApiKeyProviders(home).sort()).toEqual(['deepseek', 'openai'])
	})

	it('does not save a pasted subscription token, which lapses in hours', () => {
		const token = 'sk-ant-oat01-fake-subscription-token'
		expect(saveTypedKey('anthropic', token, home)).toEqual({ kind: 'session-only' })
		expect(existsSync(apiKeysPath(home))).toBe(false)
	})

	it('lets an environment key win over the saved one', async () => {
		saveTypedKey('deepseek', KEY, home)
		const found = (await discover({ DEEPSEEK_API_KEY: OTHER })).find(
			(d) => d.entry.id === 'deepseek',
		)
		expect(found?.apiKey).toBe(OTHER)
		expect(found?.source.kind).toBe('env')
	})

	it('says it is saved, not that it is written nowhere', () => {
		const text = describeDisposition(PROVIDER_REGISTRY.deepseek, { kind: 'verified' })
		expect(text).toContain('save this API key privately for future launches')
		expect(text).toContain('/logout deepseek')
		expect(text).not.toContain('not written anywhere')
		const token = describeDisposition(
			PROVIDER_REGISTRY.anthropic,
			{ kind: 'verified' },
			'subscription-token',
		)
		expect(token).toContain('not written anywhere')
	})
})

describe('logout removes a saved key', () => {
	it('names the providers that have one', () => {
		expect(apiKeyLogoutTarget('deepseek')).toBe('key:deepseek')
		expect(apiKeyLogoutTarget('DeepSeek')).toBe('key:deepseek')
		expect(apiKeyLogoutTarget('anthropic-key')).toBe('key:anthropic')
		// These words keep their old meaning.
		expect(apiKeyLogoutTarget('anthropic')).toBeNull()
		expect(apiKeyLogoutTarget('gemini')).toBeNull()
		expect(apiKeyLogoutTarget('codex')).toBeNull()
		expect(apiKeyLogoutTarget('nonsense')).toBeNull()
	})

	it('removes one key and keeps the rest', async () => {
		saveTypedKey('deepseek', KEY, home)
		saveTypedKey('openai', OTHER, home)
		clearStoredApiKey('deepseek', home)
		expect(readStoredApiKey('deepseek', home)).toBeNull()
		expect(readStoredApiKey('openai', home)).toBe(OTHER)
		expect((await discover()).find((d) => d.entry.id === 'deepseek')).toBeUndefined()
	})

	it('removes every key for logout all', () => {
		saveTypedKey('deepseek', KEY, home)
		saveTypedKey('openai', OTHER, home)
		clearAllStoredApiKeys(home)
		expect(existsSync(apiKeysPath(home))).toBe(false)
	})
})

describe('keys from earlier builds', () => {
	const accounts = () => createAccountRegistry({ home: join(home, '.namzu'), readers: {} })

	it('moves an /auth account key once, with a one-line notice, and leaves the account alone', async () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		const registry = accounts()
		registry.add({ provider: 'deepseek', label: 'work', kind: 'api-key', apiKey: KEY })
		expect((await discover()).find((d) => d.entry.id === 'deepseek')).toBeUndefined()

		const notice = await migrateAccountKeys(registry, { home })
		expect(notice).toMatch(/^Moved your saved .*DeepSeek.* API key/)
		expect(notice?.split('\n')).toHaveLength(1)
		expect((await discover()).find((d) => d.entry.id === 'deepseek')?.apiKey).toBe(KEY)

		// The account still resolves exactly as before.
		const id = registry.list('deepseek').find((a) => a.label === 'work')?.id ?? ''
		expect((await registry.resolve(id, new AbortController().signal)).accessToken).toBe(KEY)

		// Once: a removed key is not brought back at the next start.
		clearStoredApiKey('deepseek', home)
		expect(await migrateAccountKeys(registry, { home })).toBeNull()
		expect(readStoredApiKey('deepseek', home)).toBeNull()
		expect(existsSync(keyMigrationMarkerPath(home))).toBe(true)
	})

	it('never overwrites a key that is already saved', async () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeStoredApiKey('deepseek', OTHER, home)
		const registry = accounts()
		registry.add({ provider: 'deepseek', label: 'work', kind: 'api-key', apiKey: KEY })
		expect(await migrateAccountKeys(registry, { home })).toBeNull()
		expect(readStoredApiKey('deepseek', home)).toBe(OTHER)
	})

	it('skips an account aimed at a custom endpoint', async () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		const registry = accounts()
		registry.add({
			provider: 'openai',
			label: 'proxy',
			kind: 'api-key',
			apiKey: KEY,
			baseUrl: 'https://proxy.example.test/v1',
		})
		expect(await migrateAccountKeys(registry, { home })).toBeNull()
		expect(readStoredApiKey('openai', home)).toBeNull()
	})

	it('says nothing and writes nothing when there is nothing to move', async () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		expect(await migrateAccountKeys(accounts(), { home })).toBeNull()
		expect(existsSync(apiKeysPath(home))).toBe(false)
	})

	it('keeps a Gemini key where startup reads it', async () => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		const registry = accounts()
		registry.add({ provider: 'google', label: 'work', kind: 'api-key', apiKey: KEY })
		await migrateAccountKeys(registry, { home })
		expect((await discover()).find((d) => d.entry.id === 'google')?.apiKey).toBe(KEY)
	})
})

describe('a key added with /auth', () => {
	it('also becomes the startup key when the provider has none', async () => {
		expect(keepAccountKeyForStartup('deepseek', KEY, undefined, home)).toEqual({
			kind: 'saved',
			path: apiKeysPath(home),
		})
		expect((await discover()).find((d) => d.entry.id === 'deepseek')?.apiKey).toBe(KEY)
	})

	it('does not replace a key that is already saved, or take a custom endpoint', () => {
		writeStoredApiKey('deepseek', OTHER, home)
		expect(keepAccountKeyForStartup('deepseek', KEY, undefined, home)).toBeNull()
		expect(readStoredApiKey('deepseek', home)).toBe(OTHER)
		expect(keepAccountKeyForStartup('openai', KEY, 'https://x.example.test', home)).toBeNull()
	})

	it('leaves Gemini alone when it has a key', () => {
		writeStoredGeminiApiKey(OTHER, home)
		expect(keepAccountKeyForStartup('google', KEY, undefined, home)).toBeNull()
	})
})
