import { describe, expect, it } from 'vitest'

import { toToolResultBlocks } from '../client.js'

/**
 * The whole tool result used to be `JSON.stringify`d, so a screenshot's
 * base64 payload went into the prompt as JSON text: unreadable to the
 * model and ruinous in tokens.
 *
 * This wire format carries images natively, so the fix is not a
 * placeholder — it is sending the image as an image. A placeholder is the
 * downgrade the text-only drivers accept because their wire has no room.
 */

const PNG_BYTES = 'iVBORw0KGgo='

describe('toToolResultBlocks', () => {
	it('sends an image as an image, not as text', () => {
		const blocks = toToolResultBlocks([{ type: 'image', data: PNG_BYTES, mediaType: 'image/png' }])

		expect(blocks).toHaveLength(1)
		const image = (blocks[0] as { image?: { format: string; source: { bytes: Uint8Array } } }).image
		expect(image?.format).toBe('png')
		expect(image?.source.bytes).toBeInstanceOf(Uint8Array)
		expect(image?.source.bytes.length).toBeGreaterThan(0)
	})

	it('never puts base64 in a text block', () => {
		const blocks = toToolResultBlocks([
			{ type: 'text', text: 'here is the screen' },
			{ type: 'image', data: PNG_BYTES, mediaType: 'image/png' },
		])

		const allText = blocks.map((b) => (b as { text?: string }).text ?? '').join('')
		expect(allText).not.toContain(PNG_BYTES)
		expect(allText).toContain('here is the screen')
	})

	it('keeps text and image as separate blocks, in order', () => {
		const blocks = toToolResultBlocks([
			{ type: 'text', text: 'before' },
			{ type: 'image', data: PNG_BYTES, mediaType: 'image/jpeg' },
			{ type: 'text', text: 'after' },
		])

		expect(blocks).toHaveLength(3)
		expect((blocks[0] as { text?: string }).text).toBe('before')
		expect((blocks[1] as { image?: unknown }).image).toBeDefined()
		expect((blocks[2] as { text?: string }).text).toBe('after')
	})

	it('names an unsupported media type instead of smuggling it through', () => {
		const blocks = toToolResultBlocks([{ type: 'image', data: PNG_BYTES, mediaType: 'image/tiff' }])

		const text = (blocks[0] as { text?: string }).text ?? ''
		expect(text).not.toContain(PNG_BYTES)
		expect(text).toContain('image/tiff')
	})

	it('passes a plain string straight through', () => {
		expect(toToolResultBlocks('just text')).toEqual([{ text: 'just text' }])
	})

	it('never returns an empty block list', () => {
		// An empty tool result is rejected on the wire.
		expect(toToolResultBlocks([]).length).toBeGreaterThan(0)
	})
})
