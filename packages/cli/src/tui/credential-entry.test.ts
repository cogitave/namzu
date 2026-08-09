import { describe, expect, it } from 'vitest'

import {
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
		const unverifiable = describeDisposition(entry, { kind: 'unverifiable' })
		expect(unverifiable).toContain('NOT checked')
		expect(unverifiable).not.toContain('accepted the key')

		const verified = describeDisposition(entry, { kind: 'verified' })
		expect(verified).toContain('accepted the key')
	})

	it('reports a rejection without implying anything was kept', () => {
		const text = describeDisposition(entry, { kind: 'rejected', reason: 'HTTP 401' })
		expect(text).toContain('HTTP 401')
		expect(text).toContain('Nothing was stored')
	})

	it('never contains a key, because it is never given one', () => {
		// The signature is the guarantee: a function with no access to the secret
		// cannot put it in a message that reaches a transcript.
		expect(describeDisposition.length).toBe(2)
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
})
