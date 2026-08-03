import { describe, expect, it } from 'vitest'

import { OLLAMA_CAPABILITIES } from '../client.js'

/**
 * This driver never reads `params.tools`, so no tool schema reaches the
 * model. That is a legitimate state — and it is only legitimate while the
 * capability flags say so.
 *
 * The runtime reads `supportsTools` and, when tools are registered against
 * a driver that declares false, strips every tool surface from the prompt
 * and the request so the model is never told about tools it cannot call.
 * A flag flipped ahead of the mapping would send the model a catalogue the
 * driver then drops: the model calls a tool, nothing carries the call, and
 * the run stalls in a loop with no error to read.
 */

describe('the declared capabilities are the honest ones', () => {
	it('does not claim tools, because none are mapped', () => {
		expect(OLLAMA_CAPABILITIES.supportsTools).toBe(false)
	})

	it('does not claim function calling either', () => {
		// The two are separate flags and the runtime reads both; claiming
		// one without the other would tell it a half-truth.
		expect(OLLAMA_CAPABILITIES.supportsFunctionCalling).toBe(false)
	})

	it('claims the streaming it does implement', () => {
		expect(OLLAMA_CAPABILITIES.supportsStreaming).toBe(true)
	})

	it('does not claim vision, since attachments are dropped', () => {
		expect(OLLAMA_CAPABILITIES.supportsVision).toBe(false)
	})

	it('does not claim documents', () => {
		expect(OLLAMA_CAPABILITIES.supportsDocuments).toBe(false)
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
			expect(typeof OLLAMA_CAPABILITIES[flag]).toBe('boolean')
		}
	})
})
