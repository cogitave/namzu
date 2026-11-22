import { describe, expect, it } from 'vitest'

import {
	type Interruption,
	describeTurnInterruption,
	describeTurnStop,
	handoffContinuationNote,
} from './turn-interruption.js'

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

	it('reads the compaction cause out of the message even when the provider sentence hides the rest', () => {
		const text = describeTurnInterruption(
			failed({
				message:
					'openai (HTTP 400) — the request exceeded the model context window: prompt is too long · automatic compaction failed: reducer backend down',
				providerError: {
					kind: 'context_overflow',
					providerId: 'openai',
					detail: 'prompt is too long',
				},
				explanation: { id: 'provider.context_overflow', message: 'm', hint: 'h' },
			}),
		)
		expect(text).toContain('Compaction: automatic compaction failed: reducer backend down')
	})
})

describe('a turn that settled refused', () => {
	it('is never read as a finished reply, and says what to do', () => {
		expect(describeTurnStop('end_turn')).toBeUndefined()
		const text = describeTurnStop('refused')
		expect(text).toMatch(/declined to answer this message/)
		expect(text).toMatch(/esc twice/)
		expect(text).not.toMatch(/new session/i)
	})
})

describe('the note for a turn continued after a person was needed', () => {
	const at = new Date('2026-11-23T10:00:00Z')

	it('keeps the plain continue note when the person typed nothing', () => {
		const note = handoffContinuationNote('Sign in to example.test', at, 'UTC')
		expect(note).toContain('The person chose to continue')
		expect(note).not.toContain('wrote')
	})

	it('attributes a typed message to the person and asks to answer it first', () => {
		const note = handoffContinuationNote(
			'Sign in to example.test',
			at,
			'UTC',
			'use my other account\ninstead',
		)
		expect(note).toContain('the person wrote: "use my other account instead"')
		expect(note).toContain(
			'That is the person speaking to you, not a tool result. Answer it first.',
		)
		expect(note).toContain('only if it still makes sense')
		expect(note).toContain('never type a password or a code')
	})
})
