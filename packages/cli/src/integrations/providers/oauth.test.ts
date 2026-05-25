import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub the Keychain write so an expired-token refresh under test never touches
// the real macOS Keychain (this suite can run on the developer's own machine).
vi.mock('./keychain.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./keychain.js')>()
	return { ...actual, writeClaudeCodeKeychainCredential: vi.fn(() => false) }
})

import { ensureFreshAnthropicToken, refreshClaudeCodeToken } from './oauth.js'

function mockFetch(impl: typeof fetch): void {
	vi.stubGlobal('fetch', impl)
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('refreshClaudeCodeToken', () => {
	it('exchanges the refresh token and maps the response', async () => {
		mockFetch(
			(async () =>
				new Response(
					JSON.stringify({
						access_token: 'cc-new-access',
						refresh_token: 'rt-new',
						expires_in: 3600,
					}),
					{ status: 200 },
				)) as typeof fetch,
		)
		const before = Date.now()
		const cred = await refreshClaudeCodeToken('rt-old')
		expect(cred?.accessToken).toBe('cc-new-access')
		expect(cred?.refreshToken).toBe('rt-new')
		expect(cred?.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
	})

	it('keeps the old refresh token when the response omits one', async () => {
		mockFetch(
			(async () =>
				new Response(JSON.stringify({ access_token: 'cc-new' }), { status: 200 })) as typeof fetch,
		)
		const cred = await refreshClaudeCodeToken('rt-old')
		expect(cred?.accessToken).toBe('cc-new')
		expect(cred?.refreshToken).toBe('rt-old')
	})

	it('returns null on a non-2xx response', async () => {
		mockFetch((async () => new Response('nope', { status: 401 })) as typeof fetch)
		expect(await refreshClaudeCodeToken('rt')).toBeNull()
	})

	it('returns null when fetch throws', async () => {
		mockFetch((async () => {
			throw new Error('network down')
		}) as typeof fetch)
		expect(await refreshClaudeCodeToken('rt')).toBeNull()
	})

	it('returns null when the payload lacks an access token', async () => {
		mockFetch(
			(async () => new Response(JSON.stringify({ foo: 'bar' }), { status: 200 })) as typeof fetch,
		)
		expect(await refreshClaudeCodeToken('rt')).toBeNull()
	})
})

describe('ensureFreshAnthropicToken', () => {
	it('returns the current token when it is not near expiry (no refresh attempted)', async () => {
		const spy = vi.fn()
		mockFetch(spy as unknown as typeof fetch)
		const token = await ensureFreshAnthropicToken('cc-current', {
			refreshToken: 'rt',
			expiresAt: Date.now() + 60 * 60 * 1000,
		})
		expect(token).toBe('cc-current')
		expect(spy).not.toHaveBeenCalled()
	})

	it('returns the current token when there is no refresh token', async () => {
		const spy = vi.fn()
		mockFetch(spy as unknown as typeof fetch)
		const token = await ensureFreshAnthropicToken('cc-current', { expiresAt: 0 })
		expect(token).toBe('cc-current')
		expect(spy).not.toHaveBeenCalled()
	})

	it('refreshes an expired token', async () => {
		mockFetch(
			(async () =>
				new Response(JSON.stringify({ access_token: 'cc-fresh', expires_in: 3600 }), {
					status: 200,
				})) as typeof fetch,
		)
		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
		})
		expect(token).toBe('cc-fresh')
	})

	it('falls back to the stale token when refresh fails', async () => {
		mockFetch((async () => new Response('err', { status: 500 })) as typeof fetch)
		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
		})
		expect(token).toBe('cc-stale')
	})
})
