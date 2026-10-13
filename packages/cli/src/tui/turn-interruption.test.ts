import { describe, expect, it } from 'vitest'

import { type Interruption, describeTurnInterruption } from './turn-interruption.js'

const failed = (extra: Record<string, unknown>): Interruption =>
	({
		kind: 'error',
		message: 'zen (HTTP 403) — the provider rejected the request credentials',
		...extra,
	}) as unknown as Interruption

describe('the structured failure text used by exec and scheduled runs', () => {
	it('does not say a key authenticated when Zen declined a keyless free model', () => {
		const text = describeTurnInterruption(
			failed({
				providerError: {
					kind: 'auth',
					providerId: 'zen',
					status: 403,
					detail: 'FreeTierError: free tier is not available to this client',
				},
				explanation: {
					id: 'provider.permission',
					message: 'The provider refused this request.',
					hint: 'Check the model name and whether the account behind your key has access to it.',
				},
			}),
		)
		expect(text).toContain('Zen didn’t accept the free model right now.')
		expect(text).toContain('A Zen API key also works.')
		expect(text).toContain('Provider detail: FreeTierError')
		expect(text).not.toMatch(/authenticated|account behind your key/i)
	})

	it('keeps the catalogue hint for any other 403', () => {
		const text = describeTurnInterruption(
			failed({
				providerError: { kind: 'auth', providerId: 'openai', status: 403, detail: 'no access' },
				explanation: { id: 'provider.permission', message: 'm', hint: 'check the model name' },
			}),
		)
		expect(text).toContain('Next: check the model name')
	})
})
