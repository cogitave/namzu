import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub the Keychain write so an expired-token refresh under test never touches
// the real macOS Keychain (this suite can run on the developer's own machine).
vi.mock('./keychain.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./keychain.js')>()
	return { ...actual, writeAgentKeychainCredential: vi.fn(() => false) }
})

const writeStored = vi.hoisted(() => vi.fn())
const readStored = vi.hoisted(() => vi.fn(() => null))
vi.mock('./credential-store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./credential-store.js')>()
	return {
		...actual,
		writeStoredSubscriptionCredential: writeStored,
		readStoredSubscriptionCredential: readStored,
	}
})

import { writeAgentKeychainCredential } from './keychain.js'
import {
	ensureFreshAnthropicToken,
	readSubscriptionCredential,
	refreshAgentOAuthToken,
} from './oauth.js'

function mockFetch(impl: typeof fetch): void {
	vi.stubGlobal('fetch', impl)
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

function respondWithFreshToken(): void {
	mockFetch(
		(async () =>
			new Response(JSON.stringify({ access_token: 'cc-fresh', expires_in: 3600 }), {
				status: 200,
			})) as typeof fetch,
	)
}

/**
 * A refreshed token goes back to the store it came from, and to no other.
 *
 * Reading one store and writing the other is the failure this exists to
 * prevent: nothing errors, the session works, and the credential is refreshed
 * again from scratch on every single launch because the new token never
 * landed anywhere the next launch reads.
 */
describe('a refreshed credential is written back to its own store', () => {
	it("to namzu's own store when that is where it came from", async () => {
		respondWithFreshToken()
		await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
			origin: 'stored',
		})
		expect(writeStored).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'cc-fresh' }))
		expect(writeAgentKeychainCredential).not.toHaveBeenCalled()
	})

	it('to the borrowed Keychain entry when that is where it came from', async () => {
		respondWithFreshToken()
		await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
			origin: 'keychain',
		})
		expect(writeAgentKeychainCredential).toHaveBeenCalled()
		expect(writeStored).not.toHaveBeenCalled()
	})

	it('to the Keychain when no origin is stated, which is what callers predating the store meant', async () => {
		respondWithFreshToken()
		await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
		})
		expect(writeAgentKeychainCredential).toHaveBeenCalled()
		expect(writeStored).not.toHaveBeenCalled()
	})

	it('survives a store that refuses the write, keeping the token it already has', async () => {
		respondWithFreshToken()
		writeStored.mockImplementationOnce(() => {
			throw new Error('could not prove the file private')
		})
		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
			origin: 'stored',
		})
		expect(token).toBe('cc-fresh')
	})
})

describe('readSubscriptionCredential', () => {
	it("reads namzu's own store for a stored credential", () => {
		readStored.mockReturnValueOnce({ accessToken: 'from-store' } as never)
		expect(readSubscriptionCredential('stored')).toEqual({ accessToken: 'from-store' })
	})

	it("does not read namzu's store for a keychain credential", () => {
		readSubscriptionCredential('keychain')
		expect(readStored).not.toHaveBeenCalled()
	})
})

describe('refreshAgentOAuthToken', () => {
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
		const cred = await refreshAgentOAuthToken('rt-old')
		expect(cred?.accessToken).toBe('cc-new-access')
		expect(cred?.refreshToken).toBe('rt-new')
		expect(cred?.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
	})

	it('keeps the old refresh token when the response omits one', async () => {
		mockFetch(
			(async () =>
				new Response(JSON.stringify({ access_token: 'cc-new' }), { status: 200 })) as typeof fetch,
		)
		const cred = await refreshAgentOAuthToken('rt-old')
		expect(cred?.accessToken).toBe('cc-new')
		expect(cred?.refreshToken).toBe('rt-old')
	})

	it('returns null on a non-2xx response', async () => {
		mockFetch((async () => new Response('nope', { status: 401 })) as typeof fetch)
		expect(await refreshAgentOAuthToken('rt')).toBeNull()
	})

	it('returns null when fetch throws', async () => {
		mockFetch((async () => {
			throw new Error('network down')
		}) as typeof fetch)
		expect(await refreshAgentOAuthToken('rt')).toBeNull()
	})

	it('returns null when the payload lacks an access token', async () => {
		mockFetch(
			(async () => new Response(JSON.stringify({ foo: 'bar' }), { status: 200 })) as typeof fetch,
		)
		expect(await refreshAgentOAuthToken('rt')).toBeNull()
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
