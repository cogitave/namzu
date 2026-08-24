import { describe, expect, it } from 'vitest'

import type { LoginOutcome } from '../integrations/providers/index.js'
import {
	describeLoginOutcome,
	describeLoginStart,
	describeLogout,
	describeProviderLogout,
	isCompletionArgument,
} from './login-prompt.js'

const URL_ = 'https://example.invalid/oauth/authorize?client_id=x&code_challenge=y&state=z'

describe('describeLoginStart', () => {
	it('prints the address whether or not a browser was launched', () => {
		for (const browserOpened of [true, false]) {
			expect(describeLoginStart({ url: URL_, browserOpened })).toContain(URL_)
		}
	})

	it('does not claim a browser opened when none was launched', () => {
		const text = describeLoginStart({ url: URL_, browserOpened: false })
		expect(text).not.toContain('Opening your browser')
	})

	it('names the registered paste completion route', () => {
		const text = describeLoginStart({ url: URL_, browserOpened: true })
		expect(text).toContain('/login <the address, or just the code>')
		expect(text).toContain('authorization code')
		expect(text).not.toContain('automatically')
	})
})

describe('describeLoginOutcome', () => {
	it('names where the credential landed, and how to remove it', () => {
		const outcome: LoginOutcome = {
			ok: true,
			credential: { accessToken: 'zzz-secret-token-value' },
			storedAt: '/home/x/.namzu/credentials.json',
		}
		const text = describeLoginOutcome(outcome)
		expect(text).toContain('/home/x/.namzu/credentials.json')
		expect(text).toContain('/logout')
		// The credential is IN the value handed to this function, so this is the
		// place a careless rewrite would print it.
		expect(text).not.toContain('zzz-secret-token-value')
	})

	it('repeats the refusal it was given and says how to retry', () => {
		const text = describeLoginOutcome({
			ok: false,
			reason: 'HTTP 400 something.',
		})
		expect(text).toContain('HTTP 400 something.')
		expect(text).toContain('/login')
	})
})

describe('describeLogout', () => {
	it('distinguishes removing something from removing nothing', () => {
		const removed = describeLogout('/p/credentials.json', true)
		const absent = describeLogout('/p/credentials.json', false)
		expect(removed).toContain('/p/credentials.json')
		expect(removed).not.toBe(absent)
	})

	it('does not claim to have revoked anything at the provider', () => {
		// Deleting a local file is not revocation, and an operator who believes
		// otherwise leaves a live credential behind.
		expect(describeLogout('/p', true)).toContain('does not revoke')
	})

	it('says whose credential it is when there is nothing of ours to remove', () => {
		expect(describeLogout('/p', false)).toContain('environment')
	})

	it('names a targeted provider and promises to keep its sibling', () => {
		const text = describeProviderLogout('/p/credentials.json', 'codex', true)
		expect(text).toContain('Codex')
		expect(text).toContain('Other stored subscriptions were kept')
		expect(text).toContain('other tools')
	})
})

describe('isCompletionArgument', () => {
	it('treats a bare command as a start', () => {
		expect(isCompletionArgument([])).toBe(false)
		expect(isCompletionArgument([''])).toBe(false)
		expect(isCompletionArgument(['  '])).toBe(false)
	})

	it('treats anything typed after it as a completion', () => {
		expect(isCompletionArgument(['abc'])).toBe(true)
		expect(isCompletionArgument(['http://localhost:53692/callback?code=a&state=b'])).toBe(true)
	})
})
