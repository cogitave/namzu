import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountRegistry } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountActivityStore } from '../../integrations/accounts/activity.js'

import {
	apiKeyLogoutTarget,
	apiKeysPath,
	clearAllStoredApiKeys,
	clearStoredApiKey,
	clearStoredApiKeyIf,
	discoverProviders,
	listStoredApiKeyProviders,
	readOwnStoredApiKey,
	readStoredApiKey,
	readStoredGeminiApiKey,
	retireDuplicateStartupKeys,
	retirementNotice,
	writeStoredApiKey,
	writeStoredGeminiApiKey,
} from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { describeDisposition } from '../credential-entry.js'
import { saveTypedKey } from '../typed-key-save.js'

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
			PROVIDER_REGISTRY['anthropic'],
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

describe('an account key is stored once', () => {
	const accounts = () => createAccountRegistry({ home: join(home, '.namzu'), readers: {} })
	const addAccount = (provider: string, label: string, apiKey: string, baseUrl?: string) => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		return accounts().add({
			provider,
			label,
			kind: 'api-key',
			apiKey,
			...(baseUrl !== undefined ? { baseUrl } : {}),
		})
	}

	it('is found at startup from accounts.json alone, with no copy made', async () => {
		addAccount('deepseek', 'work', KEY)
		expect(existsSync(apiKeysPath(home))).toBe(false)
		expect((await discover()).find((d) => d.entry.id === 'deepseek')?.apiKey).toBe(KEY)
		expect(readStoredApiKey('deepseek', home)).toBe(KEY)
		expect(listStoredApiKeyProviders(home)).toEqual(['deepseek'])
	})

	it('reads a Gemini account key without a gemini-api-key.json', () => {
		addAccount('google', 'work', KEY)
		expect(readStoredGeminiApiKey(home)).toBe(KEY)
	})

	it('ignores an account aimed at a custom endpoint', () => {
		addAccount('openai', 'proxy', KEY, 'https://proxy.example.test/v1')
		expect(readStoredApiKey('openai', home)).toBeNull()
	})

	it('a logout removes the key from the file and from the account, once', () => {
		addAccount('deepseek', 'work', KEY)
		writeStoredApiKey('deepseek', KEY, home)
		clearStoredApiKey('deepseek', home)
		expect(readStoredApiKey('deepseek', home)).toBeNull()
		expect(
			accounts()
				.list('deepseek')
				.filter((a) => a.label === 'work'),
		).toHaveLength(0)
	})

	it("a logout keeps accounts that hold another key, and forgets the removed one's activity", () => {
		const work = addAccount('deepseek', 'work', KEY)
		const other = addAccount('deepseek', 'second', OTHER)
		writeStoredApiKey('deepseek', KEY, home)
		const activity = createAccountActivityStore({ home: join(home, '.namzu') })
		activity.markUsed(work.id, 1)
		activity.markUsed(other.id, 2)
		clearStoredApiKey('deepseek', home)
		expect(
			accounts()
				.list('deepseek')
				.map((a) => a.label),
		).not.toContain('work')
		expect(
			accounts()
				.list('deepseek')
				.map((a) => a.label),
		).toContain('second')
		expect(Object.keys(activity.read().lastUsed)).toEqual([other.id])
		expect(readStoredApiKey('deepseek', home)).toBe(OTHER)
	})

	it('a logout that cannot remove an account keeps the saved key and says so', () => {
		addAccount('deepseek', 'work', KEY)
		writeStoredApiKey('deepseek', KEY, home)
		const file = join(home, '.namzu', 'accounts.json')
		const before = readFileSync(file, 'utf8')
		// A directory in the registry's temp-file slot is not portable; a read-only file is.
		chmodSync(file, 0o400)
		chmodSync(join(home, '.namzu'), 0o500)
		try {
			if (process.getuid?.() === 0) return
			expect(() => clearStoredApiKey('deepseek', home)).toThrow(/saved key was kept/)
			expect(readOwnStoredApiKey('deepseek', home)).toBe(KEY)
			expect(readFileSync(file, 'utf8')).toBe(before)
		} finally {
			chmodSync(join(home, '.namzu'), 0o700)
			chmodSync(file, 0o600)
		}
	})

	it('does not trust an accounts.json that others can read', () => {
		if (process.platform === 'win32') return
		addAccount('deepseek', 'work', KEY)
		chmodSync(join(home, '.namzu', 'accounts.json'), 0o644)
		expect(readStoredApiKey('deepseek', home)).toBeNull()
	})
})

describe('retiring the second copy of an account key', () => {
	const accounts = () => createAccountRegistry({ home: join(home, '.namzu'), readers: {} })
	const addAccount = (provider: string, label: string, apiKey: string) => {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		return accounts().add({ provider, label, kind: 'api-key', apiKey })
	}
	const accountsFile = () => join(home, '.namzu', 'accounts.json')

	it('only the old copy: nothing to retire, the key still works', () => {
		writeStoredApiKey('deepseek', KEY, home)
		expect(retireDuplicateStartupKeys(home).retired).toEqual([])
		expect(readStoredApiKey('deepseek', home)).toBe(KEY)
	})

	it('only the account: nothing to retire', () => {
		addAccount('deepseek', 'work', KEY)
		expect(retireDuplicateStartupKeys(home).retired).toEqual([])
		expect(readStoredApiKey('deepseek', home)).toBe(KEY)
	})

	it('both with the same key: the copy goes, the account keeps working, 0600', async () => {
		const account = addAccount('deepseek', 'work', KEY)
		writeStoredApiKey('deepseek', KEY, home)
		const result = retireDuplicateStartupKeys(home)
		expect(result.retired).toEqual(['deepseek'])
		expect(existsSync(apiKeysPath(home))).toBe(false)
		expect(readStoredApiKey('deepseek', home)).toBe(KEY)
		expect((await accounts().resolve(account.id, new AbortController().signal)).accessToken).toBe(
			KEY,
		)
		expect(statSync(accountsFile()).mode & 0o777).toBe(0o600)
		expect(retirementNotice(result.retired, (id) => id)).toMatch(/stored twice/)
		expect(retireDuplicateStartupKeys(home).retired).toEqual([])
	})

	it('both with different keys: both stay and the startup key wins as before', () => {
		addAccount('deepseek', 'work', KEY)
		writeStoredApiKey('deepseek', OTHER, home)
		expect(retireDuplicateStartupKeys(home).retired).toEqual([])
		expect(readStoredApiKey('deepseek', home)).toBe(OTHER)
		expect(readFileSync(accountsFile(), 'utf8')).toContain(KEY)
	})

	it('a second account for the provider keeps the other keys when the copy of the first goes', () => {
		addAccount('deepseek', 'work', KEY)
		addAccount('deepseek', 'home', OTHER)
		writeStoredApiKey('deepseek', KEY, home)
		writeStoredApiKey('openai', OTHER, home)
		expect(retireDuplicateStartupKeys(home).retired).toEqual(['deepseek'])
		expect(readStoredApiKey('openai', home)).toBe(OTHER)
		expect(readFileSync(accountsFile(), 'utf8')).toContain(OTHER)
	})

	it('a corrupt accounts.json removes nothing', () => {
		writeStoredApiKey('deepseek', KEY, home)
		writeFileSync(accountsFile(), '{ not json')
		expect(retireDuplicateStartupKeys(home).retired).toEqual([])
		expect(readStoredApiKey('deepseek', home)).toBe(KEY)
	})

	it('a corrupt api-keys.json removes nothing and loses no account key', () => {
		addAccount('deepseek', 'work', KEY)
		writeFileSync(apiKeysPath(home), '{ not json')
		expect(retireDuplicateStartupKeys(home).retired).toEqual([])
		expect(readStoredApiKey('deepseek', home)).toBe(KEY)
		expect(readFileSync(apiKeysPath(home), 'utf8')).toBe('{ not json')
	})

	it('a copy that changed after it was read is not removed', () => {
		addAccount('deepseek', 'work', KEY)
		writeStoredApiKey('deepseek', OTHER, home)
		expect(clearStoredApiKeyIf('deepseek', KEY, home)).toBe(false)
		expect(readStoredApiKey('deepseek', home)).toBe(OTHER)
	})

	it('two runs at once remove the copy once', () => {
		addAccount('deepseek', 'work', KEY)
		writeStoredApiKey('deepseek', KEY, home)
		const first = retireDuplicateStartupKeys(home).retired
		const second = retireDuplicateStartupKeys(home).retired
		expect([...first, ...second]).toEqual(['deepseek'])
		expect(readStoredApiKey('deepseek', home)).toBe(KEY)
	})

	it('retires a Gemini copy too', () => {
		addAccount('google', 'work', KEY)
		writeStoredGeminiApiKey(KEY, home)
		expect(retireDuplicateStartupKeys(home).retired).toEqual(['google'])
		expect(readStoredGeminiApiKey(home)).toBe(KEY)
	})
})
