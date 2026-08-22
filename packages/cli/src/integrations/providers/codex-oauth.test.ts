import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { ensureFreshStoredCodexCredential } from './codex-oauth.js'
import {
	clearStoredCodexCredential,
	readStoredCodexCredential,
	writeStoredCodexCredential,
} from './credential-store.js'
import { CredentialWithdrawnError } from './oauth.js'

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function home(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-codex-refresh-'))
	roots.push(root)
	return root
}

function accessToken(accountId: string, expiresAt: number): string {
	const payload = Buffer.from(
		JSON.stringify({
			exp: Math.floor(expiresAt / 1_000),
			'https://api.openai.com/auth': { chatgpt_account_id: accountId },
		}),
	).toString('base64url')
	return `header.${payload}.signature`
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

describe('stored Codex refresh', () => {
	it('publishes the refreshed account credential with the source-compatible request', async () => {
		const root = home()
		const now = Date.now()
		writeStoredCodexCredential(
			{
				accessToken: accessToken('account-1', now - 1),
				refreshToken: 'refresh-before',
				expiresAt: now - 1,
				accountId: 'account-1',
			},
			root,
		)
		const refreshedToken = accessToken('account-1', now + 60 * 60_000)
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ access_token: refreshedToken, refresh_token: 'refresh-after' }),
					{ status: 200 },
				),
			)

		const result = await ensureFreshStoredCodexCredential(undefined, {
			home: root,
			fetch: fetchFn,
			authOrigin: 'https://auth.example.test/',
			now,
		})

		expect(fetchFn).toHaveBeenCalledTimes(1)
		expect(fetchFn.mock.calls[0]?.[0]).toBe('https://auth.example.test/oauth/token')
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
			grant_type: 'refresh_token',
			refresh_token: 'refresh-before',
		})
		expect(result).toMatchObject({
			accessToken: refreshedToken,
			refreshToken: 'refresh-after',
			accountId: 'account-1',
		})
		expect(readStoredCodexCredential(root)).toEqual(result)
	})

	it('does not overwrite a newer credential that wins while the network request is pending', async () => {
		const root = home()
		const now = Date.now()
		const original = {
			accessToken: accessToken('account-1', now - 1),
			refreshToken: 'refresh-original',
			expiresAt: now - 1,
			accountId: 'account-1',
		}
		const winner = {
			accessToken: accessToken('account-2', now + 60 * 60_000),
			refreshToken: 'refresh-winner',
			expiresAt: now + 60 * 60_000,
			accountId: 'account-2',
		}
		writeStoredCodexCredential(original, root)
		const held = deferred<Response>()
		const pending = ensureFreshStoredCodexCredential(undefined, {
			home: root,
			fetch: () => held.promise,
			now,
		})

		writeStoredCodexCredential(winner, root)
		held.resolve(
			new Response(
				JSON.stringify({
					access_token: accessToken('account-1', now + 60 * 60_000),
					refresh_token: 'refresh-from-stale-request',
				}),
				{ status: 200 },
			),
		)

		await expect(pending).resolves.toEqual(winner)
		expect(readStoredCodexCredential(root)).toEqual(winner)
	})

	it('treats logout during refresh as credential withdrawal, never as a session-local grant', async () => {
		const root = home()
		const now = Date.now()
		writeStoredCodexCredential(
			{
				accessToken: accessToken('account-1', now - 1),
				refreshToken: 'refresh-before',
				expiresAt: now - 1,
				accountId: 'account-1',
			},
			root,
		)
		const held = deferred<Response>()
		const pending = ensureFreshStoredCodexCredential(undefined, {
			home: root,
			fetch: () => held.promise,
			now,
		})

		clearStoredCodexCredential(root)
		held.resolve(
			new Response(
				JSON.stringify({
					access_token: accessToken('account-1', now + 60 * 60_000),
					refresh_token: 'refresh-after',
				}),
				{ status: 200 },
			),
		)

		await expect(pending).rejects.toBeInstanceOf(CredentialWithdrawnError)
		expect(readStoredCodexCredential(root)).toBeNull()
	})
})
