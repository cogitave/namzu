import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountLockError, CredentialWithdrawnError, codexRefreshLockPath } from '@namzu/sdk'
import type { Account } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createCodexHomeReader } from './codex-account.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

const NOW = 1_800_000_000_000
const signal = new AbortController().signal

function token(accountId: string, expiresAt: number): string {
	const payload = Buffer.from(
		JSON.stringify({
			exp: Math.floor(expiresAt / 1_000),
			'https://api.openai.com/auth': { chatgpt_account_id: accountId },
		}),
	).toString('base64url')
	return `header.${payload}.signature`
}

function account(accountDir: string): Account & { source: { kind: 'codex-home'; dir: string } } {
	return {
		id: 'codex:second',
		provider: 'codex',
		label: 'second',
		source: { kind: 'codex-home', dir: accountDir },
		createdAt: new Date(0).toISOString(),
	}
}

function codexHome(expiresAt: number, extra: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-codex-account-'))
	roots.push(root)
	const dir = join(root, 'accounts', 'codex', 'second')
	mkdirSync(dir, { recursive: true })
	const path = join(dir, 'auth.json')
	writeFileSync(
		path,
		JSON.stringify({
			OPENAI_API_KEY: null,
			tokens: {
				id_token: 'id-token',
				access_token: token('acct-1', expiresAt),
				refresh_token: 'refresh-before',
				account_id: 'acct-1',
			},
			last_refresh: '2026-01-01T00:00:00.000Z',
			...extra,
		}),
	)
	return { dir, path }
}

const noWait = async () => {}

describe('Codex home account reader', () => {
	it('returns a fresh sign-in without touching the network', async () => {
		const { dir } = codexHome(NOW + 60 * 60_000)
		const fetchFn = vi.fn<typeof fetch>()
		const read = createCodexHomeReader({ fetch: fetchFn, now: () => NOW, wait: noWait })
		const credential = await read(account(dir), signal)
		expect(credential).toMatchObject({ kind: 'oauth', accountId: 'acct-1' })
		expect(fetchFn).not.toHaveBeenCalled()
	})

	it('refreshes a lapsing sign-in in place and keeps every other field of the file', async () => {
		const { dir, path } = codexHome(NOW - 1)
		const next = token('acct-1', NOW + 60 * 60_000)
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ access_token: next, refresh_token: 'refresh-after' }), {
				status: 200,
			}),
		)
		const read = createCodexHomeReader({
			fetch: fetchFn,
			authOrigin: 'https://auth.example.test',
			now: () => NOW,
			wait: noWait,
		})
		const credential = await read(account(dir), signal)
		expect(credential.accessToken).toBe(next)
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
			grant_type: 'refresh_token',
			refresh_token: 'refresh-before',
		})
		const file = JSON.parse(readFileSync(path, 'utf8'))
		expect(file.tokens).toMatchObject({
			access_token: next,
			refresh_token: 'refresh-after',
			id_token: 'id-token',
			account_id: 'acct-1',
		})
		expect(file.OPENAI_API_KEY).toBeNull()
		expect(file.last_refresh).toBe(new Date(NOW).toISOString())
		if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
		// The lock is released.
		expect(() => statSync(codexRefreshLockPath(dir))).toThrow()
	})

	it('lets a rotation that finished during the request win instead of overwriting it', async () => {
		const { dir, path } = codexHome(NOW - 1)
		const rival = token('acct-1', NOW + 2 * 60 * 60_000)
		const fetchFn = vi.fn<typeof fetch>(async () => {
			writeFileSync(
				path,
				JSON.stringify({ tokens: { access_token: rival, refresh_token: 'refresh-rival' } }),
			)
			return new Response(
				JSON.stringify({ access_token: token('acct-1', NOW + 60 * 60_000), refresh_token: 'r2' }),
				{ status: 200 },
			)
		})
		const read = createCodexHomeReader({ fetch: fetchFn, now: () => NOW, wait: noWait })
		const credential = await read(account(dir), signal)
		expect(credential.accessToken).toBe(rival)
		expect(JSON.parse(readFileSync(path, 'utf8')).tokens.refresh_token).toBe('refresh-rival')
	})

	it('reports a missing sign-in, a refused grant and a different account as withdrawn', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'namzu-codex-account-'))
		roots.push(empty)
		const read = createCodexHomeReader({ now: () => NOW, wait: noWait })
		await expect(read(account(empty), signal)).rejects.toBeInstanceOf(CredentialWithdrawnError)

		const refused = codexHome(NOW - 1)
		const rejecting = createCodexHomeReader({
			fetch: async () => new Response('{}', { status: 400 }),
			now: () => NOW,
			wait: noWait,
		})
		await expect(rejecting(account(refused.dir), signal)).rejects.toBeInstanceOf(
			CredentialWithdrawnError,
		)

		const other = codexHome(NOW - 1)
		const swapped = createCodexHomeReader({
			fetch: async () =>
				new Response(JSON.stringify({ access_token: token('acct-OTHER', NOW + 60 * 60_000) }), {
					status: 200,
				}),
			now: () => NOW,
			wait: noWait,
		})
		await expect(swapped(account(other.dir), signal)).rejects.toBeInstanceOf(
			CredentialWithdrawnError,
		)
		// Nothing was written for the wrong account.
		expect(JSON.parse(readFileSync(other.path, 'utf8')).tokens.refresh_token).toBe('refresh-before')
	})

	it('refuses while a live process holds the account refresh lock', async () => {
		const { dir } = codexHome(NOW - 1)
		writeFileSync(codexRefreshLockPath(dir), `${process.pid}:held`)
		const fetchFn = vi.fn<typeof fetch>()
		const read = createCodexHomeReader({
			fetch: fetchFn,
			now: () => NOW,
			wait: noWait,
			lockAttempts: 2,
		})
		await expect(read(account(dir), signal)).rejects.toBeInstanceOf(AccountLockError)
		expect(fetchFn).not.toHaveBeenCalled()
	})
})
