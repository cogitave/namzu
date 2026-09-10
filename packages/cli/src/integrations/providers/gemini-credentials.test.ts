import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverProviders, signedInSubscriptionProviders } from './discover.js'
import {
	createGeminiAccessTokenResolver,
	readGeminiCredentialFile,
	readGeminiFileCredentialCandidates,
} from './gemini-credentials.js'

let home: string
const credential = (overrides: Record<string, unknown> = {}) => ({
	access_token: 'fixture-access',
	refresh_token: 'fixture-refresh',
	expiry_date: Date.now() + 3_600_000,
	...overrides,
})
const write = (value: unknown, targetHome = home) => {
	mkdirSync(join(targetHome, '.gemini'), { recursive: true })
	const path = join(targetHome, '.gemini', 'oauth_creds.json')
	writeFileSync(path, JSON.stringify(value))
	return path
}
beforeEach(() => {
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'fixture-client')
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'fixture-secret')
	home = mkdtempSync(join(tmpdir(), 'namzu-gemini-auth-'))
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe('Gemini CLI owner credentials', () => {
	it('does not confuse an installed/empty home with a signed-in account', () => {
		expect(readGeminiFileCredentialCandidates(home, {})).toEqual([])
	})
	it('discovers the paired Windows owner and keeps the Google project separate', async () => {
		const windowsHome = join(home, 'windows')
		const path = write(credential(), windowsHome)
		const detected = await discoverProviders({
			home,
			windowsHome,
			env: { GOOGLE_CLOUD_PROJECT: 'gcp-project' },
			skipKeychain: true,
			skipStored: true,
			skipProbes: true,
		})
		const gemini = detected.find((d) => d.entry.id === 'google')
		expect(gemini).toMatchObject({
			source: { kind: 'gemini-file', path },
			apiKey: 'fixture-access',
			gemini: { sourcePath: path, projectId: 'gcp-project' },
			alternatives: [],
		})
		expect(signedInSubscriptionProviders(detected)).toContain(gemini)
	})
	it('discovers the explicitly selected Gemini CLI home through provider discovery', async () => {
		const customHome = join(home, 'custom owner')
		const path = write(credential({ access_token: 'selected-account' }), customHome)
		write(credential({ access_token: 'default-account' }))
		const detected = await discoverProviders({
			home,
			env: { GEMINI_CLI_HOME: customHome },
			skipKeychain: true,
			skipStored: true,
			skipProbes: true,
		})
		expect(detected.find((d) => d.entry.id === 'google')).toMatchObject({
			apiKey: 'selected-account',
			source: { kind: 'gemini-file', path },
		})
	})
	it('does not substitute another account when the explicit owner has no session', () => {
		write(credential())
		const windowsHome = join(home, 'windows')
		write(credential(), windowsHome)
		expect(
			readGeminiFileCredentialCandidates(
				home,
				{
					GEMINI_CLI_HOME: join(home, 'signed-out-owner'),
				},
				windowsHome,
			),
		).toEqual([])
	})
	it('uses the normal home for an empty Gemini home override', () => {
		const path = write(credential())
		expect(readGeminiFileCredentialCandidates(home, { GEMINI_CLI_HOME: '' })[0]?.path).toBe(path)
	})
	it('accepts an explicit API key ahead of a borrowed device session', async () => {
		write(credential())
		const detected = await discoverProviders({
			home,
			env: { GEMINI_API_KEY: 'api-alternative' },
			skipKeychain: true,
			skipStored: true,
			skipProbes: true,
		})
		const gemini = detected.find((d) => d.entry.id === 'google')
		expect(gemini?.apiKey).toBe('api-alternative')
		expect(gemini?.gemini).toBeUndefined()
		expect(signedInSubscriptionProviders(detected)).not.toContain(gemini)
	})
	it.each([
		null,
		{},
		{ api_key: 'not-oauth' },
		credential({ access_token: '' }),
		credential({ expiry_date: 'tomorrow' }),
	])('rejects malformed owner envelopes: %j', (value) => {
		expect(readGeminiCredentialFile(write(value))).toBeNull()
	})
	it('ignores expired non-refreshable sessions', () => {
		write(credential({ expiry_date: 1, refresh_token: null }))
		expect(readGeminiFileCredentialCandidates(home, {})).toEqual([])
	})
	it('refreshes once for concurrent requests without writing borrowed credentials', async () => {
		const path = write(credential({ expiry_date: 1 }))
		const before = readFileSync(path, 'utf8')
		const request = vi.fn(async () =>
			Response.json({ access_token: 'fresh-access', expires_in: 3600 }),
		)
		const resolve = createGeminiAccessTokenResolver(path, request)
		expect(await Promise.all([resolve(), resolve()])).toEqual(['fresh-access', 'fresh-access'])
		expect(await resolve()).toBe('fresh-access')
		expect(request).toHaveBeenCalledTimes(1)
		expect(readFileSync(path, 'utf8')).toBe(before)
	})
	it('observes owner logout and account replacement instead of replaying cached auth', async () => {
		const path = write(credential())
		const resolve = createGeminiAccessTokenResolver(path)
		expect(await resolve()).toBe('fixture-access')
		write(credential({ access_token: 'new-account' }))
		expect(await resolve()).toBe('new-account')
		write({})
		await expect(resolve()).rejects.toThrow('no longer available')
	})
	it('never exposes provider response bodies on refresh failure', async () => {
		const path = write(credential({ expiry_date: 1 }))
		const resolve = createGeminiAccessTokenResolver(
			path,
			vi.fn(async () => new Response('secret-bearing-error', { status: 401 })),
		)
		await expect(resolve()).rejects.toThrow('HTTP 401')
		await expect(resolve()).rejects.not.toThrow('secret-bearing-error')
	})
	it('cancels one waiter without cancelling a sibling refresh', async () => {
		const path = write(credential({ expiry_date: 1 }))
		let respond!: (response: Response) => void
		const request = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					respond = resolve
				}),
		)
		const resolve = createGeminiAccessTokenResolver(path, request)
		const controller = new AbortController()
		const cancelled = resolve(controller.signal)
		const surviving = resolve()
		controller.abort(new Error('cancelled'))
		await expect(cancelled).rejects.toThrow('cancelled')
		respond(Response.json({ access_token: 'fresh', expires_in: 3600 }))
		await expect(surviving).resolves.toBe('fresh')
	})
})

it('does not send a borrowed refresh token without explicit matching application credentials', async () => {
	const path = write(credential({ expiry_date: 1 }))
	const request = vi.fn()
	const resolve = createGeminiAccessTokenResolver(path, request, {})
	await expect(resolve()).rejects.toThrow('Refresh it in Gemini CLI')
	expect(request).not.toHaveBeenCalled()
	write(credential({ access_token: 'owner-renewed' }))
	await expect(resolve()).resolves.toBe('owner-renewed')
})
