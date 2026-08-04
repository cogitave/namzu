import { describe, expect, it } from 'vitest'

import type { AuthConfig } from '../../../types/connector/index.js'
import { HttpConnector } from '../http.js'

/**
 * `'oauth2'` was grouped with `'none'` and `'custom'`, returning no headers.
 *
 * So a connector configured for OAuth2 sent an UNAUTHENTICATED request.
 * Every other auth type throws on a missing credential; this one quietly
 * did not, and the upstream's 401 reads as a bad token rather than as no
 * token at all — which sends whoever is debugging to look at the token.
 */

function headersFor(auth: AuthConfig): Record<string, string> {
	const connector = new HttpConnector()
	// The resolver is private by design; reaching it directly is what keeps
	// this test about the header decision rather than about fetch.
	return (
		connector as unknown as { resolveAuthHeaders(a: AuthConfig): Record<string, string> }
	).resolveAuthHeaders(auth)
}

describe('an oauth2 connector does not send an unauthenticated request', () => {
	it('sends the access token it was given', () => {
		const headers = headersFor({
			type: 'oauth2',
			credentials: { accessToken: 'tok_abc' },
		} as AuthConfig)

		expect(headers.Authorization).toBe('Bearer tok_abc')
	})

	it('accepts the token under either name', () => {
		const headers = headersFor({ type: 'oauth2', credentials: { token: 'tok_xyz' } } as AuthConfig)

		expect(headers.Authorization).toBe('Bearer tok_xyz')
	})

	it('refuses when there is no token, rather than sending nothing', () => {
		// The whole defect: an empty header set went out and the request
		// reached the upstream with no credential at all.
		expect(() => headersFor({ type: 'oauth2', credentials: {} } as AuthConfig)).toThrow(
			/accessToken/,
		)
	})

	it('refuses when credentials are absent entirely', () => {
		expect(() => headersFor({ type: 'oauth2' } as AuthConfig)).toThrow(/unauthenticated/)
	})
})

describe('the other schemes are unchanged', () => {
	it("still sends nothing for 'none'", () => {
		expect(headersFor({ type: 'none' } as AuthConfig)).toEqual({})
	})

	it("still sends nothing for 'custom', which is the host's job", () => {
		// Deliberately empty, unlike oauth2: `custom` means the host attaches
		// its own headers, so there is nothing to omit and nothing to refuse.
		expect(headersFor({ type: 'custom' } as AuthConfig)).toEqual({})
	})

	it('still sends a bearer token', () => {
		expect(
			headersFor({ type: 'bearer', credentials: { token: 't' } } as AuthConfig).Authorization,
		).toBe('Bearer t')
	})

	it('still refuses a bearer with no token', () => {
		expect(() => headersFor({ type: 'bearer', credentials: {} } as AuthConfig)).toThrow(/token/)
	})
})
