import { describe, expect, it } from 'vitest'

import {
	classifyCredential,
	describeDisposition,
	keyLooksUsable,
	maskKey,
	sessionCredential,
} from './credential-entry.js'

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-0123beef'

const entry = {
	id: 'anthropic',
	label: 'A Provider',
	defaultModel: 'a-model',
	requiresApiKey: true,
	envVars: ['PROVIDER_API_KEY', 'PROVIDER_TOKEN'],
} as never

describe('maskKey', () => {
	it('never contains the key', () => {
		const masked = maskKey(KEY)
		expect(masked).not.toContain(KEY)
		// The body of the key must not survive in any form. The tail is
		// deliberate; anything longer would let a screen recording rebuild it.
		expect(masked).not.toContain('api03')
		expect(masked).not.toContain('abcdefghij')
	})

	it('keeps a short tail so two pasted keys can be told apart', () => {
		expect(maskKey(KEY)).toContain('beef')
		expect(maskKey(`${KEY.slice(0, -4)}cafe`)).toContain('cafe')
		expect(maskKey(KEY)).not.toBe(maskKey(`${KEY.slice(0, -4)}cafe`))
	})

	it('does not leak the length', () => {
		// A mask that grows with the key reveals how long it is, and key length
		// distinguishes vendors and sometimes tiers. Two keys 160 characters
		// apart must render the same width.
		const short = maskKey(`${'x'.repeat(36)}beef`)
		const long = maskKey(`${'x'.repeat(196)}beef`)
		expect(short.length).toBe(long.length)
		expect(short).toBe(long)
	})

	it('hides a key too short to have a tail rather than showing all of it', () => {
		expect(maskKey('abc')).toBe('••••')
		expect(maskKey('abc')).not.toContain('abc')
	})

	it('is empty for nothing typed', () => {
		expect(maskKey('')).toBe('')
		expect(maskKey('   ')).toBe('')
	})
})

describe('keyLooksUsable', () => {
	it('accepts an ordinary key', () => {
		expect(keyLooksUsable(KEY).ok).toBe(true)
	})

	it('rejects nothing', () => {
		expect(keyLooksUsable('  ').ok).toBe(false)
	})

	it('catches a wrapped or truncated paste', () => {
		const r = keyLooksUsable('sk-ant-abc def')
		expect(r.ok).toBe(false)
		expect(!r.ok && r.reason).toContain('space')
	})

	it('catches a shell assignment pasted instead of the value', () => {
		const r = keyLooksUsable('ANTHROPIC_API_KEY=sk-ant-abc')
		expect(r.ok).toBe(false)
		expect(!r.ok && r.reason).toContain('shell assignment')
	})

	it('does not reject a key shape it has not seen', () => {
		// The provider is the authority. A validator that rejects a NEW valid
		// format is worse than one that lets the provider answer.
		expect(keyLooksUsable('completely-unfamiliar-but-plausible-000').ok).toBe(true)
	})

	it('accepts a base64 token carrying padding', () => {
		// The check used to reject any `=` anywhere. That is harmless for an API
		// key and wrong for a subscription token: a JWT-shaped one is base64 and
		// may end in padding, so the screen refused a valid credential and told
		// the operator their paste was a shell fragment. Nothing about it is.
		expect(keyLooksUsable('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln==').ok).toBe(true)
	})
})

describe('classifyCredential', () => {
	it('reads a subscription token from its own shape', () => {
		expect(classifyCredential(entry, 'sk-ant-oat01-abc')).toBe('subscription-token')
		expect(classifyCredential(entry, 'eyJhbGciOiJIUzI1NiJ9.abc')).toBe('subscription-token')
	})

	it('reads a console key as a key', () => {
		expect(classifyCredential(entry, KEY)).toBe('api-key')
	})

	it('trims first, so a pasted trailing newline does not change the answer', () => {
		expect(classifyCredential(entry, '  sk-ant-oat01-abc\n')).toBe('subscription-token')
	})

	it('does not invent the distinction for providers that lack it', () => {
		const other = { ...(entry as object), id: 'openai' } as never
		// Every other driver takes an API key and nothing else. Answering
		// "subscription token" for one would put a wording on screen that the
		// wire cannot honour.
		expect(classifyCredential(other, 'eyJhbGciOiJIUzI1NiJ9.abc')).toBe('api-key')
	})
})

describe('describeDisposition', () => {
	it('says the key is not stored, on every accepting branch', () => {
		for (const v of [{ kind: 'verified' }, { kind: 'unverifiable' }] as const) {
			const text = describeDisposition(entry, v)
			expect(text, v.kind).toContain('this session only')
			expect(text, v.kind).toContain('not written anywhere')
		}
	})

	it('names the environment variable that makes it durable', () => {
		expect(describeDisposition(entry, { kind: 'verified' })).toContain('PROVIDER_API_KEY')
	})

	it('does not claim a check it did not perform', () => {
		// Asserts the CLAIM, not the sentence. The wording moved from "offers no
		// way to check it" to "could not confirm it", because `unverifiable` now
		// covers two things: a driver that declares no credential probe, and one
		// whose probe could not be reached. The old phrase asserted the first and
		// would be false for a probe that timed out.
		//
		// Adjusted when the sentence started naming the KIND of credential it
		// took ("accepted the API key"), which is a claim this file did not
		// previously make and the operator now depends on. The assertion tracks
		// the claim, not the old wording.
		const unverifiable = describeDisposition(entry, { kind: 'unverifiable' })
		expect(unverifiable).toContain('NOT checked')
		expect(unverifiable).not.toContain('accepted the')

		const verified = describeDisposition(entry, { kind: 'verified' })
		expect(verified).toContain('accepted the API key')
	})

	it('reports a rejection without implying anything was kept', () => {
		const text = describeDisposition(entry, { kind: 'rejected', reason: 'HTTP 401' })
		expect(text).toContain('HTTP 401')
		expect(text).toContain('Nothing was stored')
	})

	it('never contains a key, because it is never given one', () => {
		// The signature is the guarantee: a function with no access to the secret
		// cannot put it in a message that reaches a transcript. `kind` is a
		// classification of the secret, not the secret — and it is defaulted, so
		// it does not count toward the arity this assertion reads.
		expect(describeDisposition.length).toBe(2)
	})

	it('discloses that a pasted subscription token cannot be renewed', () => {
		// The whole reason the kind is tracked. A discovered subscription token
		// arrives with refresh data and is renewed between turns; a pasted one has
		// none, so it lapses in hours. Said at the paste, or discovered as a 401
		// mid-turn.
		const text = describeDisposition(entry, { kind: 'verified' }, 'subscription-token')
		expect(text).toContain('subscription token')
		expect(text).toContain('expires')
		expect(text).toContain('no refresh data')
	})

	it('does not warn about expiry for a key that does not expire', () => {
		const text = describeDisposition(entry, { kind: 'verified' }, 'api-key')
		expect(text).not.toContain('expires')
		expect(text).toContain('API key')
	})

	it('names the kind in a rejection too', () => {
		const text = describeDisposition(
			entry,
			{ kind: 'rejected', reason: '401' },
			'subscription-token',
		)
		expect(text).toContain('subscription token')
		expect(text).toContain('Nothing was stored')
	})
})

describe('sessionCredential', () => {
	it('is shaped like a discovered provider so every path treats it alike', () => {
		const cred = sessionCredential(entry, ` ${KEY} `)
		expect(cred.apiKey).toBe(KEY)
		expect(cred.entry).toBe(entry)
		expect(cred.alternatives).toEqual([])
	})

	it('is marked as typed, so a surface can say it disappears', () => {
		expect(sessionCredential(entry, KEY).source).toEqual({ kind: 'session' })
	})

	it('claims no refresh path, for a subscription token as much as a key', () => {
		// `oauth` means "renewable from a refresh token", and the session layer
		// gates its refresh on the field being present. A paste supplies no
		// refresh token, so filling it in would turn a disclosed expiry into a
		// silent 401 at the moment the token lapsed.
		expect(sessionCredential(entry, 'sk-ant-oat01-abc').oauth).toBeUndefined()
	})
})
