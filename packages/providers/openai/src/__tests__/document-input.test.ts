import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { OPENAI_CAPABILITIES, toOpenAIMessages } from '../client.js'

/**
 * This driver declared `supportsDocuments: true` and had no document
 * branch: every attachment became an `image_url` part, so a PDF went up as
 * `data:application/pdf;base64,...` inside an image. The capability was a
 * claim nothing in the mapper could honour.
 *
 * Citations are the other half, and this wire has no way to return them.
 * Sending the document anyway would answer the question and drop the
 * checkability the caller asked for — silently, since an empty citation
 * list reads as "the model cited nothing" rather than "nobody asked". So a
 * document requesting citations is refused here rather than degraded.
 */

const PDF = 'JVBERi0xLjQKJSVFT0Y='

function partsFor(attachments: unknown[], content = 'summarize this') {
	const [message] = toOpenAIMessages([
		{ role: 'user', content, attachments },
	] as unknown as ChatCompletionParams['messages'])
	return message?.content as unknown as Array<Record<string, unknown>>
}

describe('a document attachment reaches the wire as a file', () => {
	it('sends a file part, not an image part', async () => {
		const parts = partsFor([{ type: 'document', data: PDF, mediaType: 'application/pdf' }])

		const file = parts.find((p) => p.type === 'file')
		expect(file?.file).toMatchObject({ file_data: `data:application/pdf;base64,${PDF}` })
		// The bug in one assertion: it used to be an image part.
		expect(parts.some((p) => p.type === 'image_url')).toBe(false)
	})

	it('keeps the prose ahead of the file', () => {
		const parts = partsFor([{ type: 'document', data: PDF, mediaType: 'application/pdf' }])

		expect(parts[0]).toEqual({ type: 'text', text: 'summarize this' })
	})

	it('carries the filename when one was given', () => {
		const parts = partsFor([
			{ type: 'document', data: PDF, mediaType: 'application/pdf', name: 'lease.pdf' },
		])

		expect((parts.find((p) => p.type === 'file')?.file as { filename?: string }).filename).toBe(
			'lease.pdf',
		)
	})

	it('omits the filename when none was given', () => {
		const parts = partsFor([{ type: 'document', data: PDF, mediaType: 'application/pdf' }])

		expect(parts.find((p) => p.type === 'file')?.file).not.toHaveProperty('filename')
	})

	it('still maps an image attachment as an image', () => {
		const parts = partsFor([{ type: 'image', data: 'AAAA', mediaType: 'image/png' }])

		expect(parts.find((p) => p.type === 'image_url')?.image_url).toEqual({
			url: 'data:image/png;base64,AAAA',
		})
		expect(parts.some((p) => p.type === 'file')).toBe(false)
	})

	it('carries both kinds in one message, in the order given', () => {
		const parts = partsFor([
			{ type: 'document', data: PDF, mediaType: 'application/pdf' },
			{ type: 'image', data: 'AAAA', mediaType: 'image/png' },
		])

		expect(parts.map((p) => p.type)).toEqual(['text', 'file', 'image_url'])
	})

	it('leaves a plain text message as a string', () => {
		const [message] = toOpenAIMessages([
			{ role: 'user', content: 'no attachments here' },
		] as ChatCompletionParams['messages'])

		expect(message?.content).toBe('no attachments here')
	})
})

describe('a document asking for citations is refused, not answered without them', () => {
	it('throws rather than sending it', () => {
		expect(() =>
			partsFor([{ type: 'document', data: PDF, mediaType: 'application/pdf', citations: true }]),
		).toThrow(/citations/i)
	})

	it('names the document, so the caller knows which one to change', () => {
		expect(() =>
			partsFor([
				{
					type: 'document',
					data: PDF,
					mediaType: 'application/pdf',
					name: 'lease.pdf',
					citations: true,
				},
			]),
		).toThrow(/lease\.pdf/)
	})

	it('says what to do instead', () => {
		expect(() =>
			partsFor([{ type: 'document', data: PDF, mediaType: 'application/pdf', citations: true }]),
		).toThrow(/Drop `citations`/)
	})

	it('accepts the same document without the request', () => {
		expect(() =>
			partsFor([{ type: 'document', data: PDF, mediaType: 'application/pdf', citations: false }]),
		).not.toThrow()
	})
})

describe('the capability claim matches the mapper', () => {
	it('declares document support, which is now true', () => {
		expect(OPENAI_CAPABILITIES.supportsDocuments).toBe(true)
	})
})
