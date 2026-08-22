import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { CODEX_OAUTH_CLIENT_ID, beginCodexDeviceLogin } from './codex-device-login.js'
import { readStoredCodexCredential } from './credential-store.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function accessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			exp: Math.floor(Date.now() / 1_000) + 3600,
			'https://api.openai.com/auth': { chatgpt_account_id: accountId },
		}),
	).toString('base64url')
	return `header.${payload}.signature`
}

it('completes the source-compatible device flow and stores the routed account', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-codex-device-'))
	roots.push(home)
	const fetchFn = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_auth_id: 'device-1',
					user_code: 'ABCD-EFGH',
					interval: '0',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		.mockResolvedValueOnce(new Response('', { status: 403 }))
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					authorization_code: 'authorization-1',
					code_challenge: 'challenge-1',
					code_verifier: 'verifier-1',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id_token: 'id-token',
					access_token: accessToken('account-1'),
					refresh_token: 'refresh-1',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)

	const login = await beginCodexDeviceLogin({
		home,
		fetch: fetchFn,
		pollTimeoutMs: 2_000,
	})
	expect(login.url).toBe('https://auth.openai.com/codex/device')
	expect(login.userCode).toBe('ABCD-EFGH')
	const outcome = await login.waitForCompletion()
	expect(outcome.ok).toBe(true)
	expect(readStoredCodexCredential(home)).toMatchObject({
		accountId: 'account-1',
		refreshToken: 'refresh-1',
	})

	const firstBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
	expect(firstBody).toEqual({ client_id: CODEX_OAUTH_CLIENT_ID })
	const exchange = fetchFn.mock.calls[3]
	expect(exchange?.[0]).toBe('https://auth.openai.com/oauth/token')
	expect(exchange?.[1]?.headers).toMatchObject({
		'content-type': 'application/x-www-form-urlencoded',
	})
	expect(String(exchange?.[1]?.body)).toContain('code_verifier=verifier-1')
	expect(String(exchange?.[1]?.body)).not.toContain('challenge-1')
})

it('stores nothing when the exchange cannot identify the routed account', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-codex-device-bad-'))
	roots.push(home)
	const fetchFn = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_auth_id: 'device-1',
					user_code: 'CODE',
					interval: '0',
				}),
				{ status: 200 },
			),
		)
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					authorization_code: 'code',
					code_verifier: 'verifier',
				}),
				{ status: 200 },
			),
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: 'not-a-jwt', refresh_token: 'refresh' }), {
				status: 200,
			}),
		)
	const login = await beginCodexDeviceLogin({ home, fetch: fetchFn })
	expect(await login.waitForCompletion()).toMatchObject({ ok: false })
	expect(readStoredCodexCredential(home)).toBeNull()
})

it('cancels a pending poll without leaving its delay timer alive', async () => {
	vi.useFakeTimers()
	try {
		const home = mkdtempSync(join(tmpdir(), 'namzu-codex-device-cancel-'))
		roots.push(home)
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						device_auth_id: 'device-1',
						user_code: 'CODE',
						interval: '60',
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(new Response('', { status: 403 }))
		const login = await beginCodexDeviceLogin({ home, fetch: fetchFn })
		const completion = login.waitForCompletion()
		await vi.advanceTimersByTimeAsync(0)
		expect(fetchFn).toHaveBeenCalledTimes(2)
		expect(vi.getTimerCount()).toBe(1)

		login.cancel()
		await expect(completion).resolves.toMatchObject({
			ok: false,
			reason: expect.stringMatching(/cancelled/),
		})
		expect(vi.getTimerCount()).toBe(0)
		expect(readStoredCodexCredential(home)).toBeNull()
	} finally {
		vi.useRealTimers()
	}
})
