import { describe, expect, it } from 'vitest'

import { OPENAI_CAPABILITIES, assertThinkingSupported } from '../client.js'

/**
 * This driver does not implement extended thinking, and used to accept the
 * request anyway.
 *
 * So a caller who asked for reasoning got an ordinary completion: no
 * thinking, no reasoning blocks, and no error. The empty reasoning list
 * that came back reads as "the model did not reason" rather than "nobody
 * asked it to" — which is the failure mode, not the missing feature. Same
 * call as the citations one in this driver: refuse what cannot be
 * delivered rather than deliver something else quietly.
 */

describe('a thinking request is refused, not dropped', () => {
	it('refuses adaptive for the same reason it refuses manual', () => {
		// Both are a request to think, and this driver would answer either
		// with an ordinary completion and an empty reasoning list.
		expect(() => assertThinkingSupported({ thinking: { type: 'adaptive' } })).toThrow(
			/does not implement thinking/i,
		)
	})

	it('throws when thinking is asked for', () => {
		// Names the driver, which is what turns a bug report about the model
		// into a one-line configuration fix in a multi-provider setup.
		expect(() => assertThinkingSupported({ thinking: { type: 'enabled' } })).toThrow(
			/OpenAIProvider does not implement thinking/i,
		)
	})

	it('says what to do instead', () => {
		expect(() => assertThinkingSupported({ thinking: { type: 'enabled' } })).toThrow(
			/Drop `thinking`/,
		)
	})

	it('explains why silence would be worse than an error', () => {
		// The message has to name the symptom the caller would otherwise
		// see, or they will read the empty list as an answer.
		expect(() => assertThinkingSupported({ thinking: { type: 'enabled' } })).toThrow(
			/empty reasoning list/,
		)
	})
})

describe('asking for it to be off is honoured as a no-op', () => {
	it('accepts an explicit disable', () => {
		// Off is the state this driver is already in, so refusing here would
		// reject a request it is in fact satisfying.
		expect(() => assertThinkingSupported({ thinking: { type: 'disabled' } })).not.toThrow()
	})

	it('accepts a call that says nothing about thinking', () => {
		expect(() => assertThinkingSupported({})).not.toThrow()
	})
})

describe('the declared capabilities stay honest', () => {
	it('claims the tools and streaming it does implement', () => {
		expect(OPENAI_CAPABILITIES.supportsTools).toBe(true)
		expect(OPENAI_CAPABILITIES.supportsStreaming).toBe(true)
		expect(OPENAI_CAPABILITIES.supportsFunctionCalling).toBe(true)
	})

	it('claims the vision and documents it now maps', () => {
		expect(OPENAI_CAPABILITIES.supportsVision).toBe(true)
		expect(OPENAI_CAPABILITIES.supportsDocuments).toBe(true)
	})

	it('answers every flag the negotiation reads', () => {
		// An absent flag defaults to permissive, so a missing one is not a
		// neutral omission — it is a claim.
		for (const flag of [
			'supportsTools',
			'supportsStreaming',
			'supportsFunctionCalling',
			'supportsVision',
			'supportsDocuments',
		] as const) {
			expect(typeof OPENAI_CAPABILITIES[flag]).toBe('boolean')
		}
	})
})
