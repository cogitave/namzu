import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { formatSessionLogLine, parseSessionLogLine } from '../session/log-hash.js'
import { explainError } from '../types/errors/catalog.js'
import { ProviderError } from '../types/provider/errors.js'
import type { SessionRecord } from '../types/session/records.js'
import { accountBoundPayload, resolveBoundAccount } from './binding.js'
import { codexRefreshLockPath, withAccountLock, withAccountRefreshLock } from './lock.js'
import { createAccountRegistry } from './registry.js'
import { AccountLockError, AccountRegistryError, CredentialWithdrawnError } from './types.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-accounts-test-'))
	dirs.push(dir)
	return dir
}

const signal = new AbortController().signal

describe('AccountRegistry', () => {
	it('synthesises a default account per provider and stores nothing for it', () => {
		const dir = home()
		const registry = createAccountRegistry({ home: dir, defaultProviders: ['anthropic', 'codex'] })
		expect(registry.list().map((a) => a.id)).toEqual(['anthropic:default', 'codex:default'])
		expect(registry.get('codex:default')?.source).toEqual({ kind: 'existing-default' })
		expect(existsSync(join(dir, 'accounts.json'))).toBe(false)
	})

	it('reads today files exactly as before: they are never touched or migrated', async () => {
		const dir = home()
		const credentials = '{"subscription":{"accessToken":"x"}}'
		const keys = '{"version":1,"keys":{"openai":"sk-old"}}'
		writeFileSync(join(dir, 'credentials.json'), credentials)
		writeFileSync(join(dir, 'api-keys.json'), keys)
		const existingDefault = vi.fn(async () => ({ kind: 'api-key' as const, accessToken: 'sk-old' }))
		const registry = createAccountRegistry({ home: dir, readers: { existingDefault } })
		registry.add({ provider: 'openai', label: 'work', kind: 'api-key', apiKey: 'sk-work' })
		expect((await registry.resolve('openai:default', signal)).accessToken).toBe('sk-old')
		expect(existingDefault).toHaveBeenCalledWith('openai', signal)
		expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toBe(credentials)
		expect(readFileSync(join(dir, 'api-keys.json'), 'utf8')).toBe(keys)
	})

	it('adds, lists, resolves, renames and removes an API-key account', async () => {
		const dir = home()
		const registry = createAccountRegistry({
			home: dir,
			now: () => new Date('2026-10-31T00:00:00Z'),
		})
		const added = registry.add({
			provider: 'openai',
			label: 'work',
			kind: 'api-key',
			apiKey: 'sk-1',
		})
		expect(added.id).toBe('openai:work')
		expect(added.createdAt).toBe('2026-10-31T00:00:00.000Z')
		expect(JSON.stringify(registry.list('openai'))).not.toContain('sk-1')
		expect((await registry.resolve('openai:work', signal)).accessToken).toBe('sk-1')

		const renamed = registry.rename('openai:work', 'team')
		expect(renamed.id).toBe('openai:team')
		expect(registry.get('openai:work')).toBeUndefined()
		expect((await registry.resolve('openai:team', signal)).accessToken).toBe('sk-1')

		registry.remove('openai:team')
		expect(registry.list('openai').map((a) => a.id)).toEqual(['openai:default'])
		expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).not.toContain('sk-1')
		await expect(registry.resolve('openai:team', signal)).rejects.toBeInstanceOf(
			CredentialWithdrawnError,
		)
	})

	it('keeps accounts.json private to the owner', () => {
		if (process.platform === 'win32') return
		const dir = home()
		createAccountRegistry({ home: dir }).add({
			provider: 'openai',
			label: 'a',
			kind: 'api-key',
			apiKey: 'k',
		})
		expect(statSync(join(dir, 'accounts.json')).mode & 0o777).toBe(0o600)
	})

	it('refuses bad, reserved and duplicate labels and unknown accounts', () => {
		const registry = createAccountRegistry({ home: home() })
		const add = (label: string) => () =>
			registry.add({ provider: 'openai', label, kind: 'api-key', apiKey: 'k' })
		expect(add('Work')).toThrow(AccountRegistryError)
		expect(add('default')).toThrow(AccountRegistryError)
		expect(add('x'.repeat(33))).toThrow(AccountRegistryError)
		add('work')()
		expect(add('work')).toThrow(AccountRegistryError)
		expect(() => registry.rename('openai:nope', 'other')).toThrow(AccountRegistryError)
		expect(() => registry.remove('openai:default')).toThrow(AccountRegistryError)
		expect(() => registry.remove('openai:nope')).toThrow(AccountRegistryError)
	})

	it('creates a private Codex directory, delegates reading, and deletes the directory on remove', async () => {
		const dir = home()
		const codexHome = vi.fn(async () => ({
			kind: 'oauth' as const,
			accessToken: 't',
			accountId: 'acc',
		}))
		const registry = createAccountRegistry({ home: dir, readers: { codexHome } })
		const added = registry.add({ provider: 'codex', label: 'second', kind: 'codex-home' })
		const codexDir = join(dir, 'accounts', 'codex', 'second')
		expect(added.source).toEqual({ kind: 'codex-home', dir: codexDir })
		expect(existsSync(codexDir)).toBe(true)
		expect((await registry.resolve('codex:second', signal)).accountId).toBe('acc')
		registry.remove('codex:second')
		expect(existsSync(codexDir)).toBe(false)
	})

	it('refuses a Codex directory outside the accounts folder or shared by two accounts', () => {
		const dir = home()
		const outside = home()
		const registry = createAccountRegistry({ home: dir })
		expect(() =>
			registry.add({ provider: 'codex', label: 'x', kind: 'codex-home', dir: outside }),
		).toThrow(AccountRegistryError)
		const shared = join(dir, 'accounts', 'codex', 'shared')
		registry.add({ provider: 'codex', label: 'one', kind: 'codex-home', dir: shared })
		expect(() =>
			registry.add({ provider: 'codex', label: 'two', kind: 'codex-home', dir: shared }),
		).toThrow(AccountRegistryError)
	})

	it('orders next(): default first, then creation order, skipping the excluded', () => {
		const registry = createAccountRegistry({ home: home() })
		registry.add({ provider: 'openai', label: 'a', kind: 'api-key', apiKey: '1' })
		registry.add({ provider: 'openai', label: 'b', kind: 'api-key', apiKey: '2' })
		expect(registry.next('openai', ['openai:default'])?.id).toBe('openai:a')
		expect(registry.next('openai', ['openai:default', 'openai:a'])?.id).toBe('openai:b')
		expect(registry.next('openai', ['openai:default', 'openai:a', 'openai:b'])).toBeUndefined()
	})

	it('keeps fields a newer build wrote when it rewrites the store', () => {
		const dir = home()
		const registry = createAccountRegistry({ home: dir })
		registry.add({ provider: 'openai', label: 'a', kind: 'api-key', apiKey: '1' })
		const file = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))
		file.futureField = { keep: true }
		file.accounts[0].autoSwitch = true
		writeFileSync(join(dir, 'accounts.json'), JSON.stringify(file))
		registry.add({ provider: 'openai', label: 'b', kind: 'api-key', apiKey: '2' })
		const after = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))
		expect(after.futureField).toEqual({ keep: true })
		expect(after.accounts[0].autoSwitch).toBe(true)
	})

	it('refuses to run over a corrupt store instead of replacing it', () => {
		const dir = home()
		writeFileSync(join(dir, 'accounts.json'), '{not json')
		const registry = createAccountRegistry({ home: dir })
		expect(() => registry.list()).toThrow(AccountRegistryError)
		expect(() =>
			registry.add({ provider: 'openai', label: 'a', kind: 'api-key', apiKey: 'k' }),
		).toThrow(AccountRegistryError)
		expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).toBe('{not json')
	})

	it('refuses a mutation while another owner holds the store lock', () => {
		const dir = home()
		writeFileSync(join(dir, 'accounts.json.lock'), 'someone-else')
		const registry = createAccountRegistry({ home: dir })
		expect(() =>
			registry.add({ provider: 'openai', label: 'a', kind: 'api-key', apiKey: 'k' }),
		).toThrow(AccountLockError)
		expect(existsSync(join(dir, 'accounts.json.lock'))).toBe(true)
	})
})

describe('account locks', () => {
	it('releases the lock after the operation, also when it throws', async () => {
		const dir = home()
		await withAccountRefreshLock(dir, () => {
			expect(existsSync(codexRefreshLockPath(dir))).toBe(true)
		})
		expect(existsSync(codexRefreshLockPath(dir))).toBe(false)
		await expect(
			withAccountRefreshLock(dir, () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		expect(existsSync(codexRefreshLockPath(dir))).toBe(false)
	})

	it('does not let a stuck account block another', async () => {
		const a = home()
		const b = home()
		writeFileSync(codexRefreshLockPath(a), 'stuck')
		await expect(withAccountRefreshLock(a, () => 1)).rejects.toBeInstanceOf(AccountLockError)
		await expect(withAccountRefreshLock(b, () => 2)).resolves.toBe(2)
	})

	it('serialises two holders of one account: the second waits for the first', async () => {
		const dir = home()
		const order: string[] = []
		let releaseFirst: () => void = () => {}
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const first = withAccountRefreshLock(dir, async () => {
			order.push('first-in')
			await firstDone
			order.push('first-out')
		})
		// The waiter's "wait" hook is where the first holder is allowed to finish; no clock involved.
		const second = withAccountRefreshLock(
			dir,
			() => {
				order.push('second')
			},
			{
				attempts: 3,
				wait: async () => {
					releaseFirst()
					await first
				},
			},
		)
		await Promise.all([first, second])
		expect(order).toEqual(['first-in', 'first-out', 'second'])
	})

	it('never removes a successor lock it does not own', async () => {
		const dir = home()
		const lock = join(dir, 'x.lock')
		await withAccountLock(lock, () => {
			writeFileSync(lock, 'another-owner')
		})
		expect(readFileSync(lock, 'utf8')).toBe('another-owner')
	})
})

describe('account_bound record', () => {
	const envelope = {
		v: 1,
		id: '5fa59543-bdf1-4cd7-b31b-dba2421cc300',
		sessionId: '1b898770-f856-497c-a28f-8a3f5aefb0b1',
		seq: 2,
		prev: { seq: 1, offset: 0, length: 10, sha256: 'a'.repeat(64) },
		ts: '2026-10-31T09:00:00.000Z',
		gen: 1,
	} as const
	const record = (accountId: string, reason: 'start' | 'user_switch' | 'limit_switch') =>
		({
			...envelope,
			...accountBoundPayload(accountId, accountId.split(':')[0] ?? '', reason),
		}) as unknown as SessionRecord

	it('round-trips through the log line format', () => {
		const original = record('codex:work', 'limit_switch')
		const line = formatSessionLogLine(original)
		expect(parseSessionLogLine(line).record).toEqual(original)
	})

	it('refuses an unknown reason', () => {
		const line = JSON.stringify({
			...envelope,
			...accountBoundPayload('codex:w', 'codex', 'start'),
			reason: 'other',
		})
		expect(() => parseSessionLogLine(`${line}\n`)).toThrow()
	})

	it('replays to the last binding for the provider', () => {
		const registry = createAccountRegistry({ home: home() })
		registry.add({ provider: 'openai', label: 'a', kind: 'api-key', apiKey: '1' })
		registry.add({ provider: 'openai', label: 'b', kind: 'api-key', apiKey: '2' })
		const log = [
			record('openai:a', 'start'),
			record('codex:work', 'user_switch'),
			record('openai:b', 'limit_switch'),
		]
		expect(resolveBoundAccount(log, 'openai', registry)).toEqual({
			accountId: 'openai:b',
			fellBack: false,
		})
		expect(resolveBoundAccount([], 'openai', registry)).toEqual({
			accountId: 'openai:default',
			fellBack: false,
		})
	})

	it('falls back to the default when the recorded account was removed', () => {
		const registry = createAccountRegistry({ home: home() })
		registry.add({ provider: 'openai', label: 'a', kind: 'api-key', apiKey: '1' })
		const log = [record('openai:a', 'start')]
		registry.remove('openai:a')
		expect(resolveBoundAccount(log, 'openai', registry)).toEqual({
			accountId: 'openai:default',
			fellBack: true,
		})
	})
})

describe('usage_limit error code', () => {
	it('is not retried inside the turn and has its own explanation', () => {
		const error = new ProviderError({ code: 'usage_limit', message: 'limit', status: 429 })
		expect(error.retryable).toBe(false)
		expect(explainError(error)?.id).toBe('provider.usage_limit')
	})
})
