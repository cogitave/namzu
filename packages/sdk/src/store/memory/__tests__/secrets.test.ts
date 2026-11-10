import { describe, expect, it } from 'vitest'
import { findSecretShape } from '../secrets.js'

// Built by concatenation so no fixture is itself a literal credential.
const fixtures: readonly (readonly [string, string])[] = [
	['provider_token', `key ${'sk-ant-'}${'a1B2c3D4e5F6g7H8i9J0k1L2'}`],
	['provider_token', `${'gh'}${'p_'}${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`],
	['provider_token', `${'AK'}${'IA'}${'ABCDEFGHIJKLMNOP'}`],
	['provider_token', `${'xox'}${'b-'}${'1234567890-abcdefghij'}`],
	['provider_token', `Authorization: ${'Bear'}${'er '}${'abcdefghijklmnopqrstuvwx1234'}`],
	['private_key', `${'-----BEGIN '}${'RSA PRIVATE KEY-----'}\nMIIE`],
	['private_key', `${'-----BEGIN '}${'PRIVATE KEY-----'}`],
	[
		'jwt',
		`${'eyJ'}${'hbGciOiJIUzI1NiJ9'}.${'eyJ'}${'zdWIiOiIxMjM0NTY3ODkw'}.${'SflKxwRJSMeKKF2QT4fwpM'}`,
	],
	['credentialed_url', `postgres://admin:${'hunter2'}@db.internal:5432/app`],
]

describe('findSecretShape', () => {
	for (const [shape, text] of fixtures) {
		it(`flags a ${shape}`, () => {
			expect(findSecretShape(text)).toBe(shape)
		})
	}

	it('does not flag ordinary prose, paths, urls or short ids', () => {
		for (const text of [
			'Use pnpm for tests; the key is read from ANTHROPIC_API_KEY.',
			'see https://example.com/docs/page and src/store/memory/secrets.ts',
			'commit 0022c7980d3a1b2c4e5f60718293a4b5c6d7e8f9',
			'sk-learn is a library',
		]) {
			expect(findSecretShape(text, { entropy: true })).toBeUndefined()
		}
	})

	it('flags a long random token only when asked to look for entropy', () => {
		const token = 'q8Zr3KvT1mXe9LpB7sWd2NyHc5GfJa4U'
		expect(findSecretShape(`token ${token}`)).toBeUndefined()
		expect(findSecretShape(`token ${token}`, { entropy: true })).toBe('high_entropy')
	})
})
