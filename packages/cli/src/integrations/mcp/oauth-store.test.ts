import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	McpOAuthLoginRequiredError,
	McpOAuthStoreError,
	clearMcpOAuthCredentials,
	clearMcpOAuthPending,
	consumeMcpOAuthCallbackState,
	createMcpOAuthProvider,
	hasMcpOAuthTokens,
	mcpOAuthPath,
	pendingMcpOAuthIssuer,
} from './oauth-store.js'

const ENDPOINT = 'https://tools.example.test/team/mcp?workspace=one'
const OTHER_ENDPOINT = 'https://tools.example.test/team/mcp?workspace=two'
const ISSUER = 'https://login.example.test'
const OTHER_ISSUER = 'https://other-login.example.test'
const REDIRECT_ONE = 'http://127.0.0.1:39101/callback'
const REDIRECT_TWO = 'http://127.0.0.1:39102/callback'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-'))
})

afterEach(() => {
	vi.useRealTimers()
	removeTempDir(home)
})

function interactive(endpoint = ENDPOINT, redirectUrl = REDIRECT_ONE) {
	return createMcpOAuthProvider({
		endpoint,
		home,
		redirectUrl,
		onRedirect: () => {},
	})
}

function authorize(endpoint = ENDPOINT, redirectUrl = REDIRECT_ONE): void {
	const provider = interactive(endpoint, redirectUrl)
	provider.clientInformation({ issuer: ISSUER })
	provider.saveClientInformation?.(
		{ client_id: 'registered-client', issuer: ISSUER },
		{ issuer: ISSUER },
	)
	provider.tokens({ issuer: ISSUER })
	provider.saveTokens(
		{
			access_token: 'access-secret',
			refresh_token: 'refresh-secret',
			token_type: 'Bearer',
			issuer: ISSUER,
		},
		{ issuer: ISSUER },
	)
}

describe('MCP OAuth private storage', () => {
	it('binds credentials to the complete endpoint, including query and path', () => {
		authorize()
		const path = mcpOAuthPath(ENDPOINT, home)
		expect(path).not.toBe(mcpOAuthPath(OTHER_ENDPOINT, home))
		expect(path).not.toBe(mcpOAuthPath('https://tools.example.test/other/mcp?workspace=one', home))
		expect(hasMcpOAuthTokens(ENDPOINT, home)).toBe(true)
		expect(hasMcpOAuthTokens(OTHER_ENDPOINT, home)).toBe(false)
		expect(readFileSync(path, 'utf8')).toContain('access-secret')
		expect(path).not.toContain('workspace=one')
		if (platform() !== 'win32') {
			expect(statSync(path).mode & 0o777).toBe(0o600)
			expect(statSync(join(home, '.namzu', 'mcp-oauth')).mode & 0o777).toBe(0o700)
		}
	})

	it('refuses a credential file copied under another endpoint hash', () => {
		authorize()
		writeFileSync(mcpOAuthPath(OTHER_ENDPOINT, home), readFileSync(mcpOAuthPath(ENDPOINT, home)), {
			mode: 0o600,
		})
		expect(() => hasMcpOAuthTokens(OTHER_ENDPOINT, home)).toThrow(McpOAuthStoreError)
	})

	it('logs out one endpoint without touching a sibling on the same origin', () => {
		authorize(ENDPOINT)
		authorize(OTHER_ENDPOINT)
		expect(clearMcpOAuthCredentials(ENDPOINT, home)).toBe(true)
		expect(clearMcpOAuthCredentials(ENDPOINT, home)).toBe(false)
		expect(hasMcpOAuthTokens(ENDPOINT, home)).toBe(false)
		expect(hasMcpOAuthTokens(OTHER_ENDPOINT, home)).toBe(true)
	})

	it('logout removes only its own private crash leftovers after taking the lock', () => {
		authorize()
		const file = mcpOAuthPath(ENDPOINT, home)
		const orphan = `${file}.tmp.123.${'a'.repeat(24)}`
		const unrelated = `${file}.tmp.123.unrelated`
		writeFileSync(orphan, 'old-refresh-secret', { mode: 0o600 })
		writeFileSync(unrelated, 'leave-this-file', { mode: 0o600 })
		clearMcpOAuthCredentials(ENDPOINT, home)
		expect(existsSync(orphan)).toBe(false)
		expect(readFileSync(unrelated, 'utf8')).toBe('leave-this-file')
	})

	it('does not reuse a DCR registration after the interactive loopback port changes', async () => {
		authorize()
		const first = interactive()
		expect((await first.clientInformation({ issuer: ISSUER }))?.client_id).toBe('registered-client')
		const second = interactive(ENDPOINT, REDIRECT_TWO)
		expect(await second.clientInformation({ issuer: ISSUER })).toBeUndefined()
		second.saveClientInformation?.(
			{ client_id: 'new-registration', issuer: ISSUER },
			{ issuer: ISSUER },
		)
		expect(await second.tokens({ issuer: ISSUER })).toBeUndefined()
		const runtime = createMcpOAuthProvider({ endpoint: ENDPOINT, home })
		expect(String(runtime.redirectUrl)).toBe(REDIRECT_TWO)
		expect((await runtime.clientInformation({ issuer: ISSUER }))?.client_id).toBe(
			'new-registration',
		)
		expect(() => runtime.state?.()).toThrow(McpOAuthLoginRequiredError)
		expect(() =>
			runtime.redirectToAuthorization(new URL('https://login.example.test/authorize')),
		).toThrow(McpOAuthLoginRequiredError)
	})

	it('refuses a headless OAuth provider without a registered redirect', () => {
		expect(() => createMcpOAuthProvider({ endpoint: ENDPOINT, home })).toThrow(
			McpOAuthLoginRequiredError,
		)
	})

	it('refuses unstamped or differently stamped token and client writes', async () => {
		const provider = interactive()
		expect(() => provider.saveClientInformation?.({ client_id: 'x' }, { issuer: ISSUER })).toThrow(
			McpOAuthStoreError,
		)
		provider.clientInformation({ issuer: ISSUER })
		provider.saveClientInformation?.({ client_id: 'x', issuer: ISSUER }, { issuer: ISSUER })
		expect(() =>
			provider.saveTokens({ access_token: 'x', token_type: 'Bearer' }, { issuer: ISSUER }),
		).toThrow(McpOAuthStoreError)
		expect(() =>
			provider.saveTokens(
				{ access_token: 'x', token_type: 'Bearer', issuer: OTHER_ISSUER },
				{ issuer: ISSUER },
			),
		).toThrow(McpOAuthStoreError)
		provider.tokens({ issuer: ISSUER })
		provider.saveTokens(
			{ access_token: 'x', token_type: 'Bearer', issuer: ISSUER },
			{ issuer: ISSUER },
		)
		expect(await provider.tokens({ issuer: OTHER_ISSUER })).toBeUndefined()
		expect(await provider.clientInformation({ issuer: OTHER_ISSUER })).toBeUndefined()
		const file = mcpOAuthPath(ENDPOINT, home)
		const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
		record.tokens = { access_token: 'x', token_type: 'Bearer' }
		writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
		expect(() => hasMcpOAuthTokens(ENDPOINT, home)).toThrow(McpOAuthStoreError)
	})

	it('refuses DPoP tokens because this provider cannot sign DPoP proofs', () => {
		const provider = interactive()
		provider.clientInformation({ issuer: ISSUER })
		provider.saveClientInformation?.({ client_id: 'x', issuer: ISSUER }, { issuer: ISSUER })
		expect(() =>
			provider.saveTokens(
				{ access_token: 'dpop-secret', token_type: 'DPoP', issuer: ISSUER },
				{ issuer: ISSUER },
			),
		).toThrow(McpOAuthStoreError)
		provider.tokens({ issuer: ISSUER })
		provider.saveTokens(
			{ access_token: 'bearer-secret', token_type: 'bearer', issuer: ISSUER },
			{ issuer: ISSUER },
		)
		const file = mcpOAuthPath(ENDPOINT, home)
		const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
		record.tokens = { access_token: 'dpop-secret', token_type: 'DPoP', issuer: ISSUER }
		writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
		expect(() => hasMcpOAuthTokens(ENDPOINT, home)).toThrow(McpOAuthStoreError)
	})

	it('a stale refresh cannot overwrite or invalidate a newer token', async () => {
		authorize()
		const first = createMcpOAuthProvider({ endpoint: ENDPOINT, home })
		const stale = createMcpOAuthProvider({ endpoint: ENDPOINT, home })
		await first.tokens({ issuer: ISSUER })
		await stale.tokens({ issuer: ISSUER })
		first.saveTokens(
			{
				access_token: 'rotated',
				refresh_token: 'rotated-refresh',
				token_type: 'Bearer',
				issuer: ISSUER,
			},
			{ issuer: ISSUER },
		)
		expect(() =>
			stale.saveTokens(
				{ access_token: 'stale-result', token_type: 'Bearer', issuer: ISSUER },
				{ issuer: ISSUER },
			),
		).toThrow(/changed during token refresh/)
		expect(() => stale.invalidateCredentials?.('tokens')).toThrow(/changed during token refresh/)
		expect((await first.tokens({ issuer: ISSUER }))?.access_token).toBe('rotated')
	})

	it('a callback cannot publish tokens over a concurrently rotated set', async () => {
		authorize()
		const login = interactive()
		login.saveDiscoveryState?.({ authorizationServerUrl: ISSUER })
		const state = await login.state?.()
		login.saveCodeVerifier('v'.repeat(43))
		consumeMcpOAuthCallbackState(ENDPOINT, state as string, home)
		const runtime = createMcpOAuthProvider({ endpoint: ENDPOINT, home })
		await runtime.tokens({ issuer: ISSUER })
		runtime.saveTokens(
			{ access_token: 'newer', token_type: 'Bearer', issuer: ISSUER },
			{ issuer: ISSUER },
		)
		expect(() =>
			login.saveTokens(
				{ access_token: 'callback-result', token_type: 'Bearer', issuer: ISSUER },
				{ issuer: ISSUER },
			),
		).toThrow(/changed during token refresh/)
		expect((await runtime.tokens({ issuer: ISSUER }))?.access_token).toBe('newer')
	})

	it('a callback cannot use a client registration replaced during browser consent', async () => {
		authorize()
		const login = interactive()
		login.saveDiscoveryState?.({ authorizationServerUrl: ISSUER })
		const state = await login.state?.()
		login.saveCodeVerifier('v'.repeat(43))
		const replacement = interactive(ENDPOINT, REDIRECT_TWO)
		await replacement.clientInformation({ issuer: ISSUER })
		replacement.saveClientInformation?.(
			{ client_id: 'different-client', issuer: ISSUER },
			{ issuer: ISSUER },
		)
		expect(() => consumeMcpOAuthCallbackState(ENDPOINT, state as string, home)).toThrow(
			McpOAuthStoreError,
		)
	})

	it('holds discovery and PKCE through a one-use state check', () => {
		const provider = interactive()
		provider.saveDiscoveryState?.({ authorizationServerUrl: ISSUER })
		const state = provider.state?.()
		expect(typeof state).toBe('string')
		provider.saveCodeVerifier('v'.repeat(43))
		expect(pendingMcpOAuthIssuer(ENDPOINT, home)).toBe(ISSUER)
		expect(() => provider.codeVerifier()).toThrow(McpOAuthStoreError)
		expect(() => consumeMcpOAuthCallbackState(ENDPOINT, 'wrong-state', home)).toThrow(
			McpOAuthStoreError,
		)
		provider.saveDiscoveryState?.({ authorizationServerUrl: OTHER_ISSUER })
		consumeMcpOAuthCallbackState(ENDPOINT, state as string, home)
		expect(provider.discoveryState?.()).toEqual({ authorizationServerUrl: ISSUER })
		expect(provider.codeVerifier()).toBe('v'.repeat(43))
		expect(() => consumeMcpOAuthCallbackState(ENDPOINT, state as string, home)).toThrow(
			McpOAuthStoreError,
		)
		clearMcpOAuthPending(ENDPOINT, home)
		expect(() => provider.codeVerifier()).toThrow(McpOAuthStoreError)
	})

	it('expires a pending browser callback without racing wall time', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-09-26T10:00:00Z'))
		const provider = interactive()
		provider.saveDiscoveryState?.({ authorizationServerUrl: ISSUER })
		const state = provider.state?.()
		provider.saveCodeVerifier('v'.repeat(43))
		vi.advanceTimersByTime(11 * 60 * 1000)
		expect(() => consumeMcpOAuthCallbackState(ENDPOINT, state as string, home)).toThrow(
			McpOAuthStoreError,
		)
	})

	it.skipIf(platform() === 'win32')('refuses broad modes and symlinks on reads', () => {
		authorize()
		const file = mcpOAuthPath(ENDPOINT, home)
		chmodSync(file, 0o644)
		expect(() => hasMcpOAuthTokens(ENDPOINT, home)).toThrow(/readable beyond its owner/)
		chmodSync(file, 0o600)
		const target = join(home, 'target.json')
		writeFileSync(target, readFileSync(file))
		rmSync(file)
		symlinkSync(target, file)
		expect(() => hasMcpOAuthTokens(ENDPOINT, home)).toThrow(McpOAuthStoreError)
	})

	it('does not overwrite another process while its endpoint lock is present', () => {
		authorize()
		const file = mcpOAuthPath(ENDPOINT, home)
		const original = readFileSync(file, 'utf8')
		writeFileSync(`${file}.lock`, 'other-process', { mode: 0o600 })
		const provider = createMcpOAuthProvider({ endpoint: ENDPOINT, home })
		expect(() =>
			provider.saveTokens(
				{ access_token: 'new', token_type: 'Bearer', issuer: ISSUER },
				{ issuer: ISSUER },
			),
		).toThrow(McpOAuthStoreError)
		expect(readFileSync(file, 'utf8')).toBe(original)
		expect(existsSync(`${file}.lock`)).toBe(true)
	})

	it('logout removes a malformed credential file without reading its contents', () => {
		authorize()
		const file = mcpOAuthPath(ENDPOINT, home)
		writeFileSync(file, '{broken-json', { mode: 0o600 })
		expect(() => hasMcpOAuthTokens(ENDPOINT, home)).toThrow(McpOAuthStoreError)
		expect(clearMcpOAuthCredentials(ENDPOINT, home)).toBe(true)
		expect(existsSync(file)).toBe(false)
	})

	it('rejects fragments, embedded credentials and non-loopback cleartext endpoints', () => {
		for (const endpoint of [
			'https://tools.example.test/mcp#fragment',
			'https://alice:secret@tools.example.test/mcp',
			'http://tools.example.test/mcp',
		]) {
			expect(() => mcpOAuthPath(endpoint, home)).toThrow(McpOAuthStoreError)
		}
	})
})
