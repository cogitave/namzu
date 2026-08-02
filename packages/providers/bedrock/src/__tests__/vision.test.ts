import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toBedrockMessages } from '../client.js'

/**
 * User attachments were dropped outright, so someone who attached a
 * screenshot got a turn about nothing. The tool-result path already
 * carried images natively; the user path never looked at `attachments`.
 */

const PNG = 'iVBORw0KGgo='

function userMessage(
	attachments: readonly { data: string; mediaType: string }[],
	content = 'what is this',
): ChatCompletionParams['messages'] {
	return [{ role: 'user', content, attachments }]
}

const blocksOf = (messages: ReturnType<typeof toBedrockMessages>, at = 0) =>
	(messages[at]?.content ?? []) as Array<{ text?: string; image?: { format: string } }>

describe('user attachments', () => {
	it('sends an image as image bytes beside the text', () => {
		const blocks = blocksOf(toBedrockMessages(userMessage([{ data: PNG, mediaType: 'image/png' }])))

		expect(blocks[0]?.text).toBe('what is this')
		expect(blocks[1]?.image?.format).toBe('png')
	})

	it('never lets the payload reach the prompt as text', () => {
		const messages = toBedrockMessages(userMessage([{ data: PNG, mediaType: 'image/png' }]))
		const text = blocksOf(messages)
			.map((b) => b.text ?? '')
			.join('')
		expect(text).not.toContain(PNG)
	})

	it('names a format the service rejects instead of failing the request', () => {
		const blocks = blocksOf(
			toBedrockMessages(userMessage([{ data: PNG, mediaType: 'image/tiff' }])),
		)

		expect(blocks.some((b) => b.image !== undefined)).toBe(false)
		const text = blocks.map((b) => b.text ?? '').join('\n')
		expect(text).toContain('image/tiff')
		expect(text).not.toContain(PNG)
	})

	it('carries several attachments in order', () => {
		const blocks = blocksOf(
			toBedrockMessages(
				userMessage([
					{ data: PNG, mediaType: 'image/png' },
					{ data: PNG, mediaType: 'image/webp' },
				]),
			),
		)

		expect(blocks.filter((b) => b.image !== undefined).map((b) => b.image?.format)).toEqual([
			'png',
			'webp',
		])
	})

	it('sends an image with no text beside it', () => {
		const blocks = blocksOf(
			toBedrockMessages(userMessage([{ data: PNG, mediaType: 'image/png' }], '')),
		)

		// An empty text block alongside would be a message the model has to
		// read as blank; the image alone is the message.
		expect(blocks).toHaveLength(1)
		expect(blocks[0]?.image?.format).toBe('png')
	})

	it('never emits a message with no content at all', () => {
		for (const messages of [
			toBedrockMessages([{ role: 'user', content: '' }]),
			toBedrockMessages(userMessage([], '')),
		]) {
			for (const message of messages) {
				expect((message.content ?? []).length).toBeGreaterThan(0)
			}
		}
	})

	it('leaves a message with no attachments exactly as it was', () => {
		const blocks = blocksOf(toBedrockMessages([{ role: 'user', content: 'plain' }]))
		expect(blocks).toEqual([{ text: 'plain' }])
	})
})
