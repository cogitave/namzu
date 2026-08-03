import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toOpenAIMessages } from '../client.js'

/**
 * A user turn could carry images and nothing else, so "here is the
 * contract, answer questions about it" meant having a tool read the file
 * and stringify it — losing the native file handling this wire has and
 * paying the text cost instead.
 */

const messages = (list: unknown[]): ChatCompletionParams['messages'] =>
	list as ChatCompletionParams['messages']

const partsOf = (out: ReturnType<typeof toOpenAIMessages>) => {
	const user = out.find((m) => m.role === 'user')
	return Array.isArray(user?.content) ? user.content : []
}

describe('a document attached to a user turn', () => {
	it('becomes a file part carrying the base64 data URI', () => {
		const out = toOpenAIMessages(
			messages([
				{
					role: 'user',
					content: 'summarise the contract',
					attachments: [
						{
							type: 'document',
							data: 'JVBERi0xLjQK',
							mediaType: 'application/pdf',
							name: 'contract.pdf',
						},
					],
				},
			]),
		)

		expect(partsOf(out)).toEqual([
			{ type: 'text', text: 'summarise the contract' },
			{
				type: 'file',
				file: {
					file_data: 'data:application/pdf;base64,JVBERi0xLjQK',
					filename: 'contract.pdf',
				},
			},
		])
	})

	it('still treats an attachment with no discriminant as an image', () => {
		const out = toOpenAIMessages(
			messages([
				{
					role: 'user',
					content: 'what is this',
					attachments: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
				},
			]),
		)

		expect(partsOf(out)[1]).toMatchObject({ type: 'image_url' })
	})

	it('omits the filename when the attachment has no name', () => {
		const out = toOpenAIMessages(
			messages([
				{
					role: 'user',
					content: 'read it',
					attachments: [{ type: 'document', data: 'JVBERi0xLjQK', mediaType: 'application/pdf' }],
				},
			]),
		)

		expect(partsOf(out)[1]).toEqual({
			type: 'file',
			file: { file_data: 'data:application/pdf;base64,JVBERi0xLjQK' },
		})
	})
})
