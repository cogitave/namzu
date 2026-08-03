import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { LMSTUDIO_CAPABILITIES, toLMStudioChat } from '../client.js'

/**
 * Tool calls are not first-class on this chat API, so a tool result is
 * folded into a marked user message. The fold is the whole contract, and
 * the interesting half is what goes INSIDE the marker.
 *
 * It used to be a JSON dump, so a result carrying an image put its base64
 * into the prompt: the model paid for every character, could read none of
 * them, and had nothing telling it something had been withheld. The named
 * placeholder is the difference between a degraded result and a misleading
 * one.
 */

const PNG = 'iVBORw0KGgo='

function chatFor(content: unknown) {
	return toLMStudioChat([
		{ role: 'user', content: 'take a shot' },
		{ role: 'tool', toolCallId: 'call_1', content },
	] as unknown as ChatCompletionParams['messages'])
}

describe('a tool result is folded into a marked user turn', () => {
	it('marks it so the model can tell it apart from a person speaking', () => {
		const chat = chatFor('the file body')

		expect(chat[1]).toEqual({ role: 'user', content: '[tool-result] the file body' })
	})

	it('names an image rather than carrying it', () => {
		const content =
			chatFor([{ type: 'image', mediaType: 'image/png', data: PNG }])[1]?.content ?? ''

		expect(content).toContain('image/png')
		expect(content).toMatch(/\d+(\.\d+)? (B|KB|MB)/)
	})

	it('keeps the base64 out of the prompt', () => {
		const content =
			chatFor([{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(2048) }])[1]?.content ?? ''

		expect(content).not.toContain('A'.repeat(64))
	})

	it('keeps the text that sat alongside', () => {
		const content =
			chatFor([
				{ type: 'text', text: 'captured the window' },
				{ type: 'image', mediaType: 'image/png', data: PNG },
			])[1]?.content ?? ''

		expect(content).toContain('captured the window')
		expect(content).toContain('image/png')
	})
})

describe('roles map onto the three this API has', () => {
	it('keeps system and assistant as themselves', () => {
		const chat = toLMStudioChat([
			{ role: 'system', content: 'be terse' },
			{ role: 'assistant', content: 'ok' },
		] as ChatCompletionParams['messages'])

		expect(chat.map((m) => m.role)).toEqual(['system', 'assistant'])
	})

	it('folds anything else onto user', () => {
		const chat = toLMStudioChat([
			{ role: 'user', content: 'hi' },
			{ role: 'tool', toolCallId: 'c', content: 'x' },
		] as unknown as ChatCompletionParams['messages'])

		expect(chat.every((m) => m.role === 'user')).toBe(true)
	})
})

describe('the declared capabilities are the honest ones', () => {
	it('does not claim tools, because no schema is sent', () => {
		expect(LMSTUDIO_CAPABILITIES.supportsTools).toBe(false)
		expect(LMSTUDIO_CAPABILITIES.supportsFunctionCalling).toBe(false)
	})

	it('claims the streaming it does implement', () => {
		expect(LMSTUDIO_CAPABILITIES.supportsStreaming).toBe(true)
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
			expect(typeof LMSTUDIO_CAPABILITIES[flag]).toBe('boolean')
		}
	})
})
