import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub the Keychain write so an expired-token refresh under test never touches
// the real macOS Keychain (this suite can run on the developer's own machine).
const readKeychain = vi.hoisted(() => vi.fn(() => null))
const writeKeychain = vi.hoisted(() => vi.fn(() => false))
vi.mock('./keychain.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./keychain.js')>()
	return {
		...actual,
		readAgentKeychainCredential: readKeychain,
		writeAgentKeychainCredential: writeKeychain,
	}
})

const writeStored = vi.hoisted(() => vi.fn())
const readStored = vi.hoisted(() => vi.fn(() => null))
const replaceStored = vi.hoisted(() =>
	vi.fn(
		(
			_expected: { accessToken: string },
			replacement: {
				accessToken: string
				refreshToken?: string
				expiresAt?: number
			},
		) => {
			writeStored(replacement)
			return { replaced: true, current: replacement }
		},
	),
)
vi.mock('./credential-store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./credential-store.js')>()
	return {
		...actual,
		writeStoredSubscriptionCredential: writeStored,
		readStoredSubscriptionCredential: readStored,
		replaceStoredSubscriptionCredential: replaceStored,
	}
})

const claudeOwner = vi.hoisted(() => ({
	current: null as null | {
		accessToken: string
		refreshToken?: string
		expiresAt?: number
		scopes?: readonly string[]
	},
}))
const readClaude = vi.hoisted(() => vi.fn(() => claudeOwner.current))
const replaceClaude = vi.hoisted(() =>
	vi.fn(
		(
			_path: string,
			expected: {
				accessToken: string
				refreshToken?: string
				expiresAt?: number
			},
			replacement: {
				accessToken: string
				refreshToken?: string
				expiresAt?: number
			},
		) => {
			if (
				!claudeOwner.current ||
				claudeOwner.current.accessToken !== expected.accessToken ||
				claudeOwner.current.refreshToken !== expected.refreshToken ||
				claudeOwner.current.expiresAt !== expected.expiresAt
			) {
				return { replaced: false, current: claudeOwner.current }
			}
			claudeOwner.current = replacement
			return { replaced: true, current: replacement }
		},
	),
)
vi.mock('./harness-credentials.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./harness-credentials.js')>()
	return {
		...actual,
		readClaudeCredentialFile: readClaude,
		replaceClaudeCredentialFile: replaceClaude,
	}
})

import {
	CredentialPublicationError,
	CredentialRefreshRejectedError,
	CredentialWithdrawnError,
	ensureFreshAnthropicToken,
	readSubscriptionCredential,
	refreshAgentOAuthToken,
} from './oauth.js'

function mockFetch(impl: typeof fetch): void {
	vi.stubGlobal('fetch', impl)
}

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.clearAllMocks()
	claudeOwner.current = null
})

async function within<T>(operation: Promise<T>, ms = 250): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

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
			scopes: ['account:read'],
			origin: 'stored',
		})
		expect(replaceStored).toHaveBeenCalledWith(
			expect.objectContaining({
				accessToken: 'cc-stale',
				scopes: ['account:read'],
			}),
			expect.objectContaining({ accessToken: 'cc-fresh' }),
		)
		expect(writeStored).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'cc-fresh' }))
		expect(writeKeychain).not.toHaveBeenCalled()
	})

	it('keeps a borrowed Keychain refresh session-local because its owner cannot join our CAS', async () => {
		respondWithFreshToken()
		readKeychain.mockReturnValueOnce({
			accessToken: 'cc-stale',
			refreshToken: 'rt',
			expiresAt: 0,
		} as never)
		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: 0,
			origin: 'keychain',
		})
		expect(token).toBe('cc-fresh')
		expect(writeKeychain).not.toHaveBeenCalled()
		expect(writeStored).not.toHaveBeenCalled()
	})

	it('publishes a rotating grant to the exact Claude owner file', async () => {
		respondWithFreshToken()
		claudeOwner.current = {
			accessToken: 'cc-stale',
			refreshToken: 'rt',
			expiresAt: 0,
		}
		const path = '/device/.claude/.credentials.json'
		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: 0,
			origin: 'claude-file',
			sourcePath: path,
		})

		expect(token).toBe('cc-fresh')
		expect(replaceClaude).toHaveBeenCalledWith(
			path,
			expect.objectContaining({ accessToken: 'cc-stale', refreshToken: 'rt' }),
			expect.objectContaining({ accessToken: 'cc-fresh', refreshToken: 'rt' }),
		)
		expect(claudeOwner.current?.accessToken).toBe('cc-fresh')
	})

	it('requires the exact Claude owner file before consuming its grant', async () => {
		respondWithFreshToken()
		await expect(
			ensureFreshAnthropicToken('cc-stale', {
				refreshToken: 'rt',
				expiresAt: 0,
				origin: 'claude-file',
			}),
		).rejects.toBeInstanceOf(CredentialPublicationError)
	})

	it('also leaves the borrowed Keychain untouched when an older caller omits origin', async () => {
		respondWithFreshToken()
		readKeychain.mockReturnValueOnce({
			accessToken: 'cc-stale',
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
		} as never)
		await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: Date.now() - 1000,
		})
		expect(writeKeychain).not.toHaveBeenCalled()
		expect(writeStored).not.toHaveBeenCalled()
	})

	it('uses a borrowed credential its owner rotated while the refresh was pending', async () => {
		respondWithFreshToken()
		readKeychain.mockReturnValueOnce({
			accessToken: 'cc-keychain-winner',
			refreshToken: 'rt-keychain-winner',
			expiresAt: 99_999,
		} as never)

		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: 0,
			origin: 'keychain',
		})

		expect(token).toBe('cc-keychain-winner')
		expect(writeKeychain).not.toHaveBeenCalled()
	})

	it('uses a credential another owner rotated while refresh was pending', async () => {
		respondWithFreshToken()
		replaceStored.mockReturnValueOnce({
			replaced: false,
			current: {
				accessToken: 'cc-external',
				refreshToken: 'rt-external',
				expiresAt: 99_999,
			},
		})

		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt: 0,
			origin: 'stored',
		})

		expect(token).toBe('cc-external')
		expect(writeStored).not.toHaveBeenCalled()
	})

	it('refuses when the owned credential was removed while refresh was pending', async () => {
		respondWithFreshToken()
		replaceStored.mockReturnValueOnce({
			replaced: false,
			current: null,
		} as never)

		await expect(
			ensureFreshAnthropicToken('cc-stale', {
				refreshToken: 'rt',
				expiresAt: 0,
				origin: 'stored',
			}),
		).rejects.toBeInstanceOf(CredentialWithdrawnError)
		expect(writeStored).not.toHaveBeenCalled()
	})

	it('refuses when the borrowed credential disappears while refresh is pending', async () => {
		respondWithFreshToken()
		readKeychain.mockReturnValueOnce(null)

		await expect(
			ensureFreshAnthropicToken('cc-stale', {
				refreshToken: 'rt',
				expiresAt: 0,
				origin: 'keychain',
			}),
		).rejects.toBeInstanceOf(CredentialWithdrawnError)
		expect(writeKeychain).not.toHaveBeenCalled()
	})

	it('refuses when the owned store cannot prove conditional publication', async () => {
		respondWithFreshToken()
		writeStored.mockImplementationOnce(() => {
			throw new Error('could not prove the file private')
		})
		await expect(
			ensureFreshAnthropicToken('cc-stale', {
				refreshToken: 'rt',
				expiresAt: Date.now() - 1000,
				origin: 'stored',
			}),
		).rejects.toBeInstanceOf(CredentialPublicationError)
	})
})

describe('readSubscriptionCredential', () => {
	it("reads namzu's own store for a stored credential", () => {
		readStored.mockReturnValueOnce({ accessToken: 'from-store' } as never)
		expect(readSubscriptionCredential('stored')).toEqual({
			accessToken: 'from-store',
		})
	})

	it("does not read namzu's store for a keychain credential", () => {
		readSubscriptionCredential('keychain')
		expect(readStored).not.toHaveBeenCalled()
	})

	it('reads a Claude session only from the exact discovered owner file', () => {
		claudeOwner.current = { accessToken: 'from-windows-claude' }
		expect(
			readSubscriptionCredential('claude-file', '/mnt/c/Users/A/.claude/.credentials.json'),
		).toEqual({ accessToken: 'from-windows-claude' })
		expect(readClaude).toHaveBeenCalledWith('/mnt/c/Users/A/.claude/.credentials.json')
		expect(readSubscriptionCredential('claude-file')).toBeNull()
	})
})

describe('refreshAgentOAuthToken', () => {
	it('exchanges the refresh token and maps the response', async () => {
		const fetchSpy = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						access_token: 'cc-new-access',
						refresh_token: 'rt-new',
						expires_in: 3600,
					}),
					{ status: 200 },
				),
		)
		mockFetch(fetchSpy as typeof fetch)
		const before = Date.now()
		const cred = await refreshAgentOAuthToken('rt-old')
		expect(cred?.accessToken).toBe('cc-new-access')
		expect(cred?.refreshToken).toBe('rt-new')
		expect(cred?.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
		expect(
			JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, string>,
		).toMatchObject({
			grant_type: 'refresh_token',
			refresh_token: 'rt-old',
			scope:
				'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
		})
	})

	it('keeps the old refresh token when the response omits one', async () => {
		mockFetch(
			(async () =>
				new Response(JSON.stringify({ access_token: 'cc-new' }), {
					status: 200,
				})) as typeof fetch,
		)
		const cred = await refreshAgentOAuthToken('rt-old')
		expect(cred?.accessToken).toBe('cc-new')
		expect(cred?.refreshToken).toBe('rt-old')
	})

	it('returns null on a non-2xx response', async () => {
		mockFetch((async () => new Response('nope', { status: 401 })) as typeof fetch)
		expect(await refreshAgentOAuthToken('rt')).toBeNull()
	})

	it('classifies a standard 400 invalid_grant as a permanent secret-free refusal', async () => {
		const secret = 'DO_NOT_ECHO_REFRESH_BODY'
		mockFetch(
			(async () =>
				new Response(
					JSON.stringify({
						error: 'INVALID_GRANT',
						error_description: secret,
					}),
					{ status: 400 },
				)) as typeof fetch,
		)

		const error = await refreshAgentOAuthToken('rt-secret').catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(CredentialRefreshRejectedError)
		expect(error).toMatchObject({ code: 'invalid_grant' })
		expect(String(error)).toContain('Sign in again with /login')
		expect(String(error)).not.toContain(secret)
		expect(String(error)).not.toContain('rt-secret')
	})

	it('keeps another 400 code transient and retryable', async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'invalid_request' }), {
					status: 400,
				}),
		)
		mockFetch(fetchSpy as typeof fetch)

		await expect(refreshAgentOAuthToken('rt')).resolves.toBeNull()
		await expect(refreshAgentOAuthToken('rt')).resolves.toBeNull()
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	it('returns null when fetch throws', async () => {
		mockFetch((async () => {
			throw new Error('network down')
		}) as typeof fetch)
		expect(await refreshAgentOAuthToken('rt')).toBeNull()
	})

	it('returns null when the payload lacks an access token', async () => {
		mockFetch(
			(async () =>
				new Response(JSON.stringify({ foo: 'bar' }), {
					status: 200,
				})) as typeof fetch,
		)
		expect(await refreshAgentOAuthToken('rt')).toBeNull()
	})

	it('refuses a pre-aborted caller before starting fetch', async () => {
		const fetchSpy = vi.fn()
		mockFetch(fetchSpy as unknown as typeof fetch)
		const controller = new AbortController()
		const cause = new Error('turn was stopped before refresh')
		controller.abort(cause)

		await expect(refreshAgentOAuthToken('rt', controller.signal)).rejects.toBe(cause)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('settles on caller cancellation when fetch ignores its signal', async () => {
		let transportSignal: AbortSignal | undefined
		mockFetch(((_url: string | URL | Request, init?: RequestInit) => {
			transportSignal = init?.signal ?? undefined
			return new Promise<Response>(() => {})
		}) as typeof fetch)
		const controller = new AbortController()
		const cause = new Error('run authority withdrawn')
		const pending = refreshAgentOAuthToken('rt', controller.signal)
		await vi.waitFor(() => expect(transportSignal).toBeDefined())

		controller.abort(cause)

		await expect(within(pending)).rejects.toBe(cause)
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(cause)
	})

	it('settles on caller cancellation when the response body ignores its signal', async () => {
		let bodyStarted = false
		mockFetch(
			(async () =>
				({
					ok: true,
					json: () => {
						bodyStarted = true
						return new Promise<never>(() => {})
					},
				}) as unknown as Response) as typeof fetch,
		)
		const controller = new AbortController()
		const cause = new Error('body no longer belongs to a run')
		const pending = refreshAgentOAuthToken('rt', controller.signal)
		await vi.waitFor(() => expect(bodyStarted).toBe(true))

		controller.abort(cause)

		await expect(within(pending)).rejects.toBe(cause)
	})

	it('settles on caller cancellation while reading a non-2xx classification body', async () => {
		let bodyStarted = false
		mockFetch(
			(async () =>
				({
					ok: false,
					status: 400,
					json: () => {
						bodyStarted = true
						return new Promise<never>(() => {})
					},
				}) as unknown as Response) as typeof fetch,
		)
		const controller = new AbortController()
		const cause = new Error('classification body lost its owner')
		const pending = refreshAgentOAuthToken('rt', controller.signal)
		await vi.waitFor(() => expect(bodyStarted).toBe(true))

		controller.abort(cause)

		await expect(within(pending)).rejects.toBe(cause)
	})

	it('preserves the caller cause when fetch reports only a generic AbortError', async () => {
		let transportSignal: AbortSignal | undefined
		mockFetch(((_url: string | URL | Request, init?: RequestInit) => {
			transportSignal = init?.signal ?? undefined
			return new Promise<Response>((_resolve, reject) => {
				transportSignal?.addEventListener(
					'abort',
					() => reject(new DOMException('The operation was aborted.', 'AbortError')),
					{ once: true },
				)
			})
		}) as typeof fetch)
		const controller = new AbortController()
		const cause = new Error('exact stop cause')
		const pending = refreshAgentOAuthToken('rt', controller.signal)
		await vi.waitFor(() => expect(transportSignal).toBeDefined())

		controller.abort(cause)

		await expect(within(pending)).rejects.toBe(cause)
	})

	it('bounds an uncooperative refresh and keeps its best-effort null contract', async () => {
		vi.useFakeTimers()
		let transportSignal: AbortSignal | undefined
		mockFetch(((_url: string | URL | Request, init?: RequestInit) => {
			transportSignal = init?.signal ?? undefined
			return new Promise<Response>(() => {})
		}) as typeof fetch)
		const pending = refreshAgentOAuthToken('rt')
		await vi.advanceTimersByTimeAsync(30_000)

		await expect(pending).resolves.toBeNull()
		expect(transportSignal?.aborted).toBe(true)
		expect((transportSignal?.reason as Error | undefined)?.name).toBe('RefreshDeadlineError')
	})

	it('does not let a later caller abort relabel a deadline that won first', async () => {
		vi.useFakeTimers()
		mockFetch((async () => new Promise<Response>(() => {})) as typeof fetch)
		const controller = new AbortController()
		const pending = refreshAgentOAuthToken('rt', controller.signal)

		vi.advanceTimersByTime(30_000)
		controller.abort(new Error('late caller cancellation'))

		await expect(pending).resolves.toBeNull()
	})

	it('refuses a body result that arrives together with caller cancellation', async () => {
		const controller = new AbortController()
		const cause = new Error('body result lost its owner')
		mockFetch(
			(async () =>
				({
					ok: true,
					json: async () => {
						controller.abort(cause)
						return { access_token: 'cc-too-late' }
					},
				}) as unknown as Response) as typeof fetch,
		)

		await expect(refreshAgentOAuthToken('rt', controller.signal)).rejects.toBe(cause)
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
		const token = await ensureFreshAnthropicToken('cc-current', {
			expiresAt: 0,
		})
		expect(token).toBe('cc-current')
		expect(spy).not.toHaveBeenCalled()
	})

	it('refreshes an expired token', async () => {
		const expiresAt = Date.now() - 1000
		readKeychain.mockReturnValueOnce({
			accessToken: 'cc-stale',
			refreshToken: 'rt',
			expiresAt,
		} as never)
		mockFetch(
			(async () =>
				new Response(JSON.stringify({ access_token: 'cc-fresh', expires_in: 3600 }), {
					status: 200,
				})) as typeof fetch,
		)
		const token = await ensureFreshAnthropicToken('cc-stale', {
			refreshToken: 'rt',
			expiresAt,
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

	it('does not turn invalid_grant into permission to use the stale token', async () => {
		mockFetch(
			(async () =>
				new Response(JSON.stringify({ error: 'invalid_grant' }), {
					status: 400,
				})) as typeof fetch,
		)

		await expect(
			ensureFreshAnthropicToken('cc-stale', {
				refreshToken: 'rt',
				expiresAt: Date.now() - 1000,
			}),
		).rejects.toBeInstanceOf(CredentialRefreshRejectedError)
	})

	it('rechecks ownership after exchange resolution and before durable publication', async () => {
		const controller = new AbortController()
		const cause = new Error('turn stopped before credential publication')
		mockFetch(
			(async () =>
				({
					ok: true,
					json: async () => ({
						access_token: 'cc-too-late',
						refresh_token: 'rt-too-late',
						// Read while the inner exchange constructs its result, after its
						// own post-body fence. The queued abort runs before the outer await
						// continuation reaches the durable store.
						get expires_in() {
							queueMicrotask(() => controller.abort(cause))
							return 3600
						},
					}),
				}) as unknown as Response) as typeof fetch,
		)

		await expect(
			ensureFreshAnthropicToken(
				'cc-stale',
				{ refreshToken: 'rt', expiresAt: 0, origin: 'stored' },
				controller.signal,
			),
		).rejects.toBe(cause)
		expect(writeStored).not.toHaveBeenCalled()
		expect(writeKeychain).not.toHaveBeenCalled()
	})
})
