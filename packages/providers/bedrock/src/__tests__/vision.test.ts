import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { BEDROCK_CAPABILITIES, toBedrockMessages } from '../client.js'

/**
 * This driver does not map image attachments, and says so.
 *
 * That is a legitimate state — a driver may ship without a wire shape —
 * but only while the claim and the code agree. The failure this pins is
 * drift in either direction: flipping the flag without writing the mapping
 * makes the runtime stop warning about images that still vanish, and
 * writing the mapping without flipping the flag makes it keep warning
 * about images that now arrive.
 *
 * The runtime reads the flag and warns (or fails under `strictCapabilities`)
 * before the request is built, so the flag is the contract.
 */

const PNG = 'iVBORw0KGgo='

function contentFor(attachments: unknown[]): unknown {
	const messages = toBedrockMessages([
		{ role: 'user', content: 'what is this', attachments },
	] as unknown as ChatCompletionParams['messages'])
	return messages[0]?.content
}

describe('the capability claim and the mapper agree', () => {
	it('declares that images are not mapped', () => {
		expect(BEDROCK_CAPABILITIES.supportsVision).toBe(false)
	})

	it('declares that documents are not mapped', () => {
		expect(BEDROCK_CAPABILITIES.supportsDocuments).toBe(false)
	})

	it('sends no image block, matching the claim', () => {
		const content = contentFor([{ type: 'image', data: PNG, mediaType: 'image/png' }])
		const blocks = content as Record<string, unknown>[]

		expect(blocks.some((b) => 'image' in b)).toBe(false)
	})

	it('does not smuggle the payload into the text either', () => {
		const content = contentFor([{ type: 'image', data: 'A'.repeat(2048), mediaType: 'image/png' }])

		// Dropping is the declared behaviour. Stringifying it into the
		// prompt would be worse than dropping: unreadable, and billed.
		expect(JSON.stringify(content)).not.toContain('A'.repeat(64))
	})

	it('still sends the message text', () => {
		const content = contentFor([{ type: 'image', data: PNG, mediaType: 'image/png' }])
		const blocks = content as Array<{ text?: string }>

		expect(blocks.some((b) => b.text === 'what is this')).toBe(true)
	})

	it('leaves a plain message untouched', () => {
		const messages = toBedrockMessages([
			{ role: 'user', content: 'no attachments' },
		] as ChatCompletionParams['messages'])

		expect(messages[0]?.content).toEqual([{ text: 'no attachments' }])
	})
})

describe('what the driver does map is unaffected', () => {
	it('maps tool calls, which is what this driver is for', () => {
		const messages = toBedrockMessages([
			{ role: 'user', content: 'read it' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
				],
			},
		] as unknown as ChatCompletionParams['messages'])

		const toolUse = (messages[1]?.content ?? []).find(
			(b) => (b as { toolUse?: unknown }).toolUse,
		) as { toolUse: { name: string; input: unknown } }

		expect(toolUse.toolUse.name).toBe('read')
		expect(toolUse.toolUse.input).toEqual({ p: 1 })
	})

	it('drops system messages from the turn list', () => {
		const messages = toBedrockMessages([
			{ role: 'system', content: 'be terse' },
			{ role: 'user', content: 'hi' },
		] as ChatCompletionParams['messages'])

		expect(messages.map((m) => m.role)).toEqual(['user'])
	})
})
