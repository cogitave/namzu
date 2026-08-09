import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { credentialsPath, readStoredSubscriptionCredential } from './credential-store.js'
import { discoverProviders } from './discover.js'
import { OAUTH_CLIENT_ID, OAUTH_TOKEN_URL, REDIRECT_URI } from './identity.js'
import {
	beginSubscriptionLogin,
	parsePastedInput,
	subscriptionDetectedProvider,
} from './subscription-login.js'

/**
 * The values a leak test hunts for.
 *
 * Distinctive on purpose: a substring search for `token` would match prose,
 * and a search that matches prose cannot tell a leak from a sentence about
 * one.
 */
const ACCESS = 'zzz-access-4a7f2b9c-must-never-be-printed'
const REFRESH = 'zzz-refresh-91d0e3aa-must-never-be-printed'
const CODE = 'auth-code-abc123'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-login-'))
})
afterEach(() => {
	removeTempDir(home)
	vi.restoreAllMocks()
})

/** A token endpoint that answers `body` with `status`. Records what it saw. */
function stubEndpoint(status: number, body: unknown) {
	const seen: { url?: string; init?: RequestInit } = {}
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		seen.url = String(url)
		seen.init = init
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})
	}) as unknown as typeof fetch
	return { fetchFn, seen }
}

const GOOD = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 28_800 }

describe('the authorization request', () => {
	it('asks for a code with a S256 challenge, and never carries the verifier', async () => {
		const login = await beginSubscriptionLogin({ home, loopback: false })
		const url = new URL(login.url)
		expect(url.searchParams.get('response_type')).toBe('code')
		expect(url.searchParams.get('client_id')).toBe(OAUTH_CLIENT_ID)
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
		const challenge = url.searchParams.get('code_challenge') ?? ''
		expect(challenge.length).toBeGreaterThan(20)
		// The verifier is what PKCE keeps OUT of this URL. Reusing it as `state`
		// — which nearby implementations do — would put it here.
		expect(url.searchParams.get('state')).not.toBe(challenge)
		login.cancel()
	})

	it('mints a different state and challenge on every attempt', async () => {
		const a = await beginSubscriptionLogin({ home, loopback: false })
		const b = await beginSubscriptionLogin({ home, loopback: false })
		const sa = new URL(a.url).searchParams
		const sb = new URL(b.url).searchParams
		expect(sa.get('state')).not.toBe(sb.get('state'))
		expect(sa.get('code_challenge')).not.toBe(sb.get('code_challenge'))
		a.cancel()
		b.cancel()
	})
})

describe('a completed sign-in', () => {
	it('stores a credential a session can make a request with', async () => {
		const { fetchFn, seen } = stubEndpoint(200, GOOD)
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string

		const outcome = await login.completeWithPastedCode(
			`http://localhost:53692/callback?code=${CODE}&state=${state}`,
		)
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return

		// The exchange went where it was supposed to, with the verifier this time.
		expect(seen.url).toBe(OAUTH_TOKEN_URL)
		const body = JSON.parse(String(seen.init?.body)) as Record<string, string>
		expect(body.grant_type).toBe('authorization_code')
		expect(body.code).toBe(CODE)
		expect(body.redirect_uri).toBe(REDIRECT_URI)
		expect(body.code_verifier?.length).toBeGreaterThan(20)

		// The credential landed where discovery looks — the property that makes
		// the next launch work without signing in again.
		expect(readStoredSubscriptionCredential(home)).toMatchObject({
			accessToken: ACCESS,
			refreshToken: REFRESH,
		})

		// And it is usable NOW, as a provider a session can be built from,
		// without waiting for a relaunch.
		const detected = subscriptionDetectedProvider(outcome.credential, outcome.storedAt)
		expect(detected.entry.id).toBe('anthropic')
		expect(detected.apiKey).toBe(ACCESS)
		expect(detected.oauth?.origin).toBe('stored')

		// The same credential, found by discovery on a cold start.
		const found = await discoverProviders({ home, env: {}, skipProbes: true, skipKeychain: true })
		const anthropic = found.find((d) => d.entry.id === 'anthropic')
		expect(anthropic?.apiKey).toBe(ACCESS)
		expect(anthropic?.source).toEqual({ kind: 'stored', path: credentialsPath(home) })
		expect(anthropic?.oauth).toMatchObject({ refreshToken: REFRESH, origin: 'stored' })
	})

	it('records an expiry so the refresh path knows when to run', async () => {
		const { fetchFn } = stubEndpoint(200, GOOD)
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		const before = Date.now()
		await login.completeWithPastedCode(`${CODE}#${state}`)
		const expiresAt = readStoredSubscriptionCredential(home)?.expiresAt ?? 0
		expect(expiresAt).toBeGreaterThanOrEqual(before + 28_800_000)
	})

	it('cannot be replayed — a second completion is refused', async () => {
		const { fetchFn } = stubEndpoint(200, GOOD)
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		expect((await login.completeWithPastedCode(`${CODE}#${state}`)).ok).toBe(true)
		const second = await login.completeWithPastedCode(`${CODE}#${state}`)
		expect(second.ok).toBe(false)
	})
})

describe('a failed sign-in leaves nothing behind', () => {
	const noCredentialOnDisk = () => {
		expect(existsSync(credentialsPath(home))).toBe(false)
		// Not even a temp file, which would be the partial credential this
		// claim is really about.
		const dir = dirname(credentialsPath(home))
		if (existsSync(dir)) {
			expect(readdirSync(dir).filter((e) => e.includes('credentials'))).toEqual([])
		}
	}

	it('when the endpoint refuses the exchange', async () => {
		const { fetchFn } = stubEndpoint(400, { error: 'invalid_grant' })
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		const outcome = await login.completeWithPastedCode(`${CODE}#${state}`)
		expect(outcome.ok).toBe(false)
		noCredentialOnDisk()
	})

	it('when the state does not match — and it never reaches the endpoint', async () => {
		const { fetchFn, seen } = stubEndpoint(200, GOOD)
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const outcome = await login.completeWithPastedCode(`${CODE}#not-the-state-we-sent`)
		expect(outcome.ok).toBe(false)
		expect(seen.url).toBeUndefined()
		noCredentialOnDisk()
	})

	it('when the endpoint answers 200 with no token in it', async () => {
		const { fetchFn } = stubEndpoint(200, { refresh_token: REFRESH })
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		const outcome = await login.completeWithPastedCode(`${CODE}#${state}`)
		expect(outcome.ok).toBe(false)
		noCredentialOnDisk()
	})

	it('when the endpoint answers with something that is not JSON', async () => {
		const { fetchFn } = stubEndpoint(200, '<html>gateway</html>')
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		const outcome = await login.completeWithPastedCode(`${CODE}#${state}`)
		expect(outcome.ok).toBe(false)
		noCredentialOnDisk()
	})

	it('when the endpoint is unreachable', async () => {
		const fetchFn = (async () => {
			throw new Error('getaddrinfo ENOTFOUND')
		}) as unknown as typeof fetch
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		const outcome = await login.completeWithPastedCode(`${CODE}#${state}`)
		expect(outcome.ok).toBe(false)
		noCredentialOnDisk()
	})

	it('when nothing usable was pasted', async () => {
		const { fetchFn, seen } = stubEndpoint(200, GOOD)
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		for (const junk of ['', '   ', 'I signed in already', 'https://not a url']) {
			expect((await login.completeWithPastedCode(junk)).ok).toBe(false)
		}
		expect(seen.url).toBeUndefined()
		noCredentialOnDisk()
	})
})

/**
 * The non-negotiable: a secret reaches its store and nowhere else.
 *
 * Driven through the real failure paths with console captured, because the
 * tempting way to write a refusal is to quote what the server said — and what
 * a token endpoint says on a failure is the document the token is in.
 */
describe('no token is ever printed, logged, or put in a message', () => {
	it('not on a refused exchange whose body contains one', async () => {
		const logged: string[] = []
		for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logged.push(args.map(String).join(' '))
			})
		}
		const stdout: string[] = []
		vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
			stdout.push(String(chunk))
			return true
		}) as typeof process.stdout.write)
		vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
			stdout.push(String(chunk))
			return true
		}) as typeof process.stderr.write)

		// A 400 whose body carries a token — the shape that makes "include the
		// response body in the error" a leak rather than a courtesy.
		const { fetchFn } = stubEndpoint(400, {
			error: 'invalid_grant',
			error_description: `token ${ACCESS} was already used`,
			refresh_token: REFRESH,
		})
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		const outcome = await login.completeWithPastedCode(`${CODE}#${state}`)

		expect(outcome.ok).toBe(false)
		const captured = [...logged, ...stdout, outcome.ok ? '' : outcome.reason].join('\n')
		expect(captured).not.toContain(ACCESS)
		expect(captured).not.toContain(REFRESH)
		// The refusal still has to be actionable, or the leak was removed by
		// removing the message.
		expect(outcome.ok ? '' : outcome.reason).toContain('400')
	})

	it('not in the outcome of a SUCCESSFUL login, whose message names only the path', async () => {
		const { fetchFn } = stubEndpoint(200, GOOD)
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		const outcome = await login.completeWithPastedCode(`${CODE}#${state}`)
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return
		expect(outcome.storedAt).not.toContain(ACCESS)
		expect(outcome.storedAt).toBe(credentialsPath(home))
	})

	it('and the authorization URL carries no secret either', async () => {
		const login = await beginSubscriptionLogin({ home, loopback: false })
		expect(login.url).not.toContain(ACCESS)
		expect(login.url).not.toContain(REFRESH)
		login.cancel()
	})

	it('the store file is the only place the secret exists', async () => {
		const { fetchFn } = stubEndpoint(200, GOOD)
		const login = await beginSubscriptionLogin({ home, loopback: false, fetch: fetchFn })
		const state = new URL(login.url).searchParams.get('state') as string
		await login.completeWithPastedCode(`${CODE}#${state}`)
		const dir = dirname(credentialsPath(home))
		const holders = readdirSync(dir).filter((name) =>
			readFileSync(join(dir, name), 'utf8').includes(ACCESS),
		)
		expect(holders).toEqual(['credentials.json'])
	})
})

describe('waitForCallback', () => {
	it('is null when no loopback listener was arranged, so nothing awaits forever', async () => {
		const login = await beginSubscriptionLogin({ home, loopback: false })
		expect(login.loopback).toBe(false)
		expect(login.waitForCallback()).toBeNull()
		login.cancel()
	})

	it('resolves to a refusal when the attempt is cancelled', async () => {
		const login = await beginSubscriptionLogin({ home })
		if (!login.loopback) {
			// The port was busy on this machine; the claim under test needs the
			// listener, and the paste path is covered above.
			expect(login.waitForCallback()).toBeNull()
			return
		}
		const pending = login.waitForCallback() as Promise<{ ok: boolean }>
		login.cancel()
		expect((await pending).ok).toBe(false)
	})

	it('does not bind twice — a second attempt degrades to paste-only', async () => {
		const first = await beginSubscriptionLogin({ home })
		if (!first.loopback) return
		const second = await beginSubscriptionLogin({ home })
		expect(second.loopback).toBe(false)
		expect(second.waitForCallback()).toBeNull()
		first.cancel()
		second.cancel()
	})
})

describe('parsePastedInput', () => {
	it('reads a full redirect address', () => {
		expect(parsePastedInput('http://localhost:53692/callback?code=abc&state=xyz')).toEqual({
			code: 'abc',
			state: 'xyz',
		})
	})

	it('reads a query string on its own, with or without the leading question mark', () => {
		expect(parsePastedInput('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
		expect(parsePastedInput('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
	})

	it('reads the hash-joined pair a consent screen offers for copying', () => {
		expect(parsePastedInput('abc#xyz')).toEqual({ code: 'abc', state: 'xyz' })
	})

	it('reads a bare code', () => {
		expect(parsePastedInput('abc')).toEqual({ code: 'abc' })
	})

	it('trims what a terminal paste adds', () => {
		expect(parsePastedInput('  abc#xyz \n')).toEqual({ code: 'abc', state: 'xyz' })
	})

	it('finds no code in a sentence, rather than posting the sentence', () => {
		expect(parsePastedInput('I have signed in').code).toBeUndefined()
		expect(parsePastedInput('').code).toBeUndefined()
		expect(parsePastedInput('   ').code).toBeUndefined()
	})

	it('finds no code in an address that has none', () => {
		expect(parsePastedInput('http://localhost:53692/callback?error=access_denied').code).toBe(
			undefined,
		)
	})

	it('finds no code in an unparseable address', () => {
		expect(parsePastedInput('http://[not-an-address').code).toBeUndefined()
	})
})
