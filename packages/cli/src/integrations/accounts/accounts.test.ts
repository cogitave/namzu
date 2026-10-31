import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createAccountRegistry } from '@namzu/sdk'
import type { Account } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../providers/preferences.js'
import { createAccountActivityStore } from './activity.js'
import {
	accountOfPreferences,
	bindAccount,
	findAccountByName,
	isDefaultAccountId,
} from './binding.js'
import { loginAddressIn, runCodexLogin } from './codex-login.js'
import {
	MAY_BE_LIMITED_WINDOW_MS,
	accountRows,
	accountState,
	describeState,
	formatResetTime,
} from './rows.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})
function home(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-accounts-'))
	roots.push(root)
	return root
}

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)
const noWait = () => undefined

function stored(id: string, provider = 'openai'): Account {
	return {
		id: `${provider}:${id}`,
		provider,
		label: id,
		source: { kind: 'api-key', keyRef: `key-${id}` },
		createdAt: new Date(0).toISOString(),
	}
}

describe('activity store', () => {
	it('remembers last use and a limit, and forgets them with the account', () => {
		const dir = home()
		const store = createAccountActivityStore({ home: dir, wait: noWait })
		expect(store.read()).toEqual({
			lastUsed: {},
			limitedUntil: {},
			mayBeLimited: {},
			autoSwitch: {},
		})
		store.markUsed('openai:a', 5)
		store.markLimited('openai:a', 99)
		store.setAutoSwitch('openai:a', true)
		expect(createAccountActivityStore({ home: dir }).read()).toEqual({
			lastUsed: { 'openai:a': 5 },
			limitedUntil: { 'openai:a': 99 },
			mayBeLimited: {},
			autoSwitch: { 'openai:a': true },
		})
		store.clearLimited('openai:a')
		expect(store.read().limitedUntil).toEqual({})
		store.forget('openai:a')
		expect(store.read()).toEqual({
			lastUsed: {},
			limitedUntil: {},
			mayBeLimited: {},
			autoSwitch: {},
		})
	})

	it('writes the file private to the user and reads a damaged one as empty', () => {
		const dir = home()
		const store = createAccountActivityStore({ home: dir, wait: noWait })
		store.markUsed('openai:a', 1)
		if (process.platform !== 'win32') {
			expect(statSync(join(dir, 'account-activity.json')).mode & 0o777).toBe(0o600)
		}
		writeFileSync(join(dir, 'account-activity.json'), '{not json')
		expect(store.read()).toEqual({
			lastUsed: {},
			limitedUntil: {},
			mayBeLimited: {},
			autoSwitch: {},
		})
	})
})

describe('account rows', () => {
	const activity = {
		lastUsed: { 'openai:b': 30, 'openai:a': 10 },
		limitedUntil: {},
		mayBeLimited: {},
		autoSwitch: {},
	}

	it('lists the last used first and keeps registry order for the rest', () => {
		const rows = accountRows({
			accounts: [stored('default'), stored('a'), stored('b'), stored('c')],
			activity,
			currentId: 'openai:a',
			now: NOW,
		})
		expect(rows.map((row) => row.account.label)).toEqual(['b', 'a', 'default', 'c'])
		expect(rows.find((row) => row.current)?.account.label).toBe('a')
	})

	it('states ready, limited until a time, and needs sign-in', () => {
		const account = stored('a')
		expect(accountState(account, activity, NOW)).toEqual({ kind: 'ready' })
		expect(
			accountState(account, { ...activity, limitedUntil: { 'openai:a': NOW + 60_000 } }, NOW),
		).toEqual({ kind: 'limited', until: NOW + 60_000 })
		// A limit in the past is over.
		expect(
			accountState(account, { ...activity, limitedUntil: { 'openai:a': NOW - 1 } }, NOW),
		).toEqual({ kind: 'ready' })
		expect(accountState(account, activity, NOW, () => false)).toEqual({
			kind: 'needs-sign-in',
		})
	})

	it('says "may be limited" with no time when none was given, keeps order, and clears on use', () => {
		const dir = home()
		const store = createAccountActivityStore({ home: dir, wait: noWait })
		store.markMayBeLimited('openai:a', NOW)
		const account = stored('a')
		const noted = store.read()
		expect(accountState(account, noted, NOW + 1000)).toEqual({ kind: 'may-be-limited' })
		expect(describeState({ kind: 'may-be-limited' }, NOW)).toBe('may be limited')
		// It is not kept forever.
		expect(accountState(account, noted, NOW + MAY_BE_LIMITED_WINDOW_MS + 1)).toEqual({
			kind: 'ready',
		})
		// Ordering is by last use only; the note does not move the row.
		const rows = accountRows({
			accounts: [stored('a'), stored('b')],
			activity: noted,
			currentId: undefined,
			now: NOW + 1000,
		})
		expect(rows.map((row) => row.account.label)).toEqual(['a', 'b'])
		store.markUsed('openai:a', NOW + 2000)
		expect(store.read().mayBeLimited).toEqual({})
	})

	it('words each state and shows another day with its weekday', () => {
		expect(describeState({ kind: 'ready' }, NOW)).toBe('ready')
		expect(describeState({ kind: 'needs-sign-in' }, NOW)).toBe('needs sign-in')
		const sameDay = formatResetTime(NOW + 3_600_000, NOW, 'en-US')
		expect(sameDay).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/)
		expect(formatResetTime(NOW + 3 * 86_400_000, NOW, 'en-US')).toMatch(
			/Mon|Tue|Wed|Thu|Fri|Sat|Sun/,
		)
		expect(describeState({ kind: 'limited', until: NOW + 3_600_000 }, NOW, 'en-US')).toBe(
			`limited until ${sameDay}`,
		)
	})
})

describe('binding an account to a chain', () => {
	const prefs: Preferences = {
		version: 3,
		providers: [
			{ id: 'anthropic', model: 'claude-x' },
			{ id: 'openai', model: 'gpt-y' },
			{ id: 'deepseek' },
		],
	}

	it('makes the account the head, as a model pick does, and drops later members of its provider', () => {
		const next = bindAccount(prefs, { ...stored('work'), defaultModel: 'glm' })
		expect(next.providers).toEqual([
			{ id: 'openai', model: 'glm', account: 'openai:work' },
			{ id: 'deepseek' },
		])
		expect(prefs.providers[0]).toEqual({ id: 'anthropic', model: 'claude-x' })
	})

	it('keeps the saved model only when the head already was that provider', () => {
		expect(bindAccount(prefs, stored('x', 'anthropic')).providers[0]).toEqual({
			id: 'anthropic',
			model: 'claude-x',
			account: 'anthropic:x',
		})
		expect(bindAccount(prefs, stored('x', 'google')).providers[0]).toEqual({
			id: 'google',
			account: 'google:x',
		})
	})

	it('names no account for the usual sign-in', () => {
		const next = bindAccount(prefs, {
			...stored('default', 'openai'),
			id: 'openai:default',
		})
		expect(next.providers[0]).toEqual({ id: 'openai' })
		expect(accountOfPreferences(next)).toBeUndefined()
		expect(accountOfPreferences(bindAccount(prefs, stored('work')))).toBe('openai:work')
		expect(isDefaultAccountId('codex:default')).toBe(true)
		expect(isDefaultAccountId('codex:work')).toBe(false)
		expect(isDefaultAccountId(undefined)).toBe(true)
	})
})

describe('finding an account by name', () => {
	it('takes a label, a provider:label, and refuses an ambiguous or unknown one in plain words', () => {
		const dir = home()
		const reg = createAccountRegistry({ home: dir, lockWait: noWait })
		reg.add({
			provider: 'openai',
			label: 'work',
			kind: 'api-key',
			apiKey: 'k1',
		})
		reg.add({
			provider: 'deepseek',
			label: 'work',
			kind: 'api-key',
			apiKey: 'k2',
		})
		reg.add({
			provider: 'openai',
			label: 'solo',
			kind: 'api-key',
			apiKey: 'k3',
		})
		expect(findAccountByName(reg, 'solo')).toMatchObject({
			account: { id: 'openai:solo' },
		})
		expect(findAccountByName(reg, 'deepseek:work')).toMatchObject({
			account: { id: 'deepseek:work' },
		})
		expect(findAccountByName(reg, 'work')).toMatchObject({
			error: expect.stringContaining('openai:work, deepseek:work'),
		})
		expect(findAccountByName(reg, 'nope')).toMatchObject({
			error: expect.stringContaining('no account called "nope"'),
		})
		expect(findAccountByName(reg, '  ')).toMatchObject({
			error: expect.any(String),
		})
	})
})

describe('Codex sign-in', () => {
	function fakeChild(
		behaviour: (
			child: EventEmitter & {
				stdout: PassThrough
				stderr: PassThrough
				kill: (s?: string) => boolean
			},
		) => void,
	) {
		return () => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: (_signal?: string) => {
					child.emit('exit', null)
					return true
				},
			})
			queueMicrotask(() => behaviour(child))
			return child as never
		}
	}
	function authJson(): string {
		const payload = Buffer.from(
			JSON.stringify({
				exp: 4_000_000_000,
				'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' },
			}),
		).toString('base64url')
		return JSON.stringify({
			tokens: {
				access_token: `h.${payload}.s`,
				refresh_token: 'r',
				account_id: 'acct-9',
			},
		})
	}

	it('runs the tool with a private home, shows its address, and reports the account it signed in', async () => {
		const dir = join(home(), 'accounts', 'codex', 'work')
		const seen: string[] = []
		let usedHome: string | undefined
		const result = await runCodexLogin({
			dir,
			signal: new AbortController().signal,
			onOutput: (line) => seen.push(line),
			env: { PATH: '/bin', CODEX_HOME: '/somewhere/else' },
			spawn: ((_c: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
				usedHome = options.env.CODEX_HOME
				expect(args).toEqual(['login'])
				return fakeChild((child) => {
					child.stdout.write('Open https://auth.example/oauth?x=1 to sign in\n')
					writeFileSync(join(dir, 'auth.json'), authJson())
					child.emit('exit', 0)
				})()
			}) as never,
		})
		expect(result).toEqual({ kind: 'signed-in', accountId: 'acct-9' })
		expect(usedHome).toBe(dir)
		expect(seen.map(loginAddressIn)).toEqual(['https://auth.example/oauth?x=1'])
		expect(existsSync(join(dir, 'auth.json'))).toBe(true)
	})

	it('removes the folder when the person cancels', async () => {
		const dir = join(home(), 'accounts', 'codex', 'work')
		const controller = new AbortController()
		const result = await runCodexLogin({
			dir,
			signal: controller.signal,
			spawn: fakeChild(() => controller.abort()) as never,
		})
		expect(result).toEqual({ kind: 'cancelled' })
		expect(existsSync(dir)).toBe(false)
	})

	it('starts nothing and creates no folder when already cancelled', async () => {
		const dir = join(home(), 'accounts', 'codex', 'work')
		const controller = new AbortController()
		controller.abort()
		let started = false
		const result = await runCodexLogin({
			dir,
			signal: controller.signal,
			spawn: (() => {
				started = true
				return fakeChild(() => undefined)()
			}) as never,
		})
		expect(result).toEqual({ kind: 'cancelled' })
		expect(started).toBe(false)
		expect(existsSync(dir)).toBe(false)
	})

	it('stops the tool when cancelled while it is starting', async () => {
		const dir = join(home(), 'accounts', 'codex', 'work')
		const controller = new AbortController()
		let stopped = false
		const result = await runCodexLogin({
			dir,
			signal: controller.signal,
			spawn: (() => {
				// The cancel lands before the listener could have been attached.
				controller.abort()
				const child = fakeChild(() => undefined)() as unknown as {
					kill: (signal?: string) => boolean
				}
				const kill = child.kill.bind(child)
				child.kill = (signal) => {
					stopped = true
					return kill(signal)
				}
				return child
			}) as never,
		})
		expect(result).toEqual({ kind: 'cancelled' })
		expect(stopped).toBe(true)
		expect(existsSync(dir)).toBe(false)
	})

	it('stops listening for a cancel once the tool has exited', async () => {
		const dir = join(home(), 'accounts', 'codex', 'work')
		const signal = new AbortController().signal
		const added = vi.spyOn(signal, 'addEventListener')
		const removed = vi.spyOn(signal, 'removeEventListener')
		await runCodexLogin({
			dir,
			signal,
			spawn: fakeChild((child) => child.emit('exit', 1)) as never,
		})
		expect(added).toHaveBeenCalledTimes(1)
		expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]?.[1])
	})

	it('removes the folder and says so plainly when the tool is missing or signs in nothing', async () => {
		const dir = join(home(), 'accounts', 'codex', 'work')
		const missing = await runCodexLogin({
			dir,
			signal: new AbortController().signal,
			spawn: fakeChild((child) =>
				child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })),
			) as never,
		})
		expect(missing).toMatchObject({ kind: 'failed', missing: true })
		expect(existsSync(dir)).toBe(false)

		const empty = await runCodexLogin({
			dir,
			signal: new AbortController().signal,
			spawn: fakeChild((child) => child.emit('exit', 0)) as never,
		})
		expect(empty).toMatchObject({ kind: 'failed' })
		expect(existsSync(dir)).toBe(false)

		const failed = await runCodexLogin({
			dir,
			signal: new AbortController().signal,
			spawn: fakeChild((child) => child.emit('exit', 2)) as never,
		})
		expect(failed).toMatchObject({ kind: 'failed' })
		expect(existsSync(dir)).toBe(false)
	})

	it('creates the folder private to the user while the tool runs', async () => {
		const dir = join(home(), 'accounts', 'codex', 'work')
		mkdirSync(join(dir, '..'), { recursive: true })
		let mode = 0
		await runCodexLogin({
			dir,
			signal: new AbortController().signal,
			spawn: (() => {
				mode = statSync(dir).mode & 0o777
				return fakeChild((child) => child.emit('exit', 1))()
			}) as never,
		})
		if (process.platform !== 'win32') expect(mode).toBe(0o700)
	})
})
