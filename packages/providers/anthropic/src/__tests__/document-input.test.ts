import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toAnthropicMessages } from '../client.js'

/**
 * A user turn could carry images and nothing else, so "here is the
 * contract, answer questions about it" meant having a tool read the file
 * and stringify it — losing the native document handling this wire has
 * and paying the text cost instead.
 */

const messages = (list: unknown[]): ChatCompletionParams['messages'] =>
	list as ChatCompletionParams['messages']

const blocksOf = (out: ReturnType<typeof toAnthropicMessages>) => {
	const user = out.find((m) => m.role === 'user')
	return Array.isArray(user?.content) ? user.content : []
}

describe('a document attached to a user turn', () => {
	it('becomes a document block, not an image block', () => {
		const out = toAnthropicMessages(
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

		expect(blocksOf(out)).toEqual([
			{ type: 'text', text: 'summarise the contract' },
			{
				type: 'document',
				source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' },
				title: 'contract.pdf',
			},
		])
	})

	it('still treats an attachment with no discriminant as an image', () => {
		// Every attachment was an image before documents existed, so the
		// discriminant has to stay optional or every existing caller breaks.
		const out = toAnthropicMessages(
			messages([
				{
					role: 'user',
					content: 'what is this',
					attachments: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
				},
			]),
		)

		expect(blocksOf(out)[1]).toMatchObject({ type: 'image' })
	})

	it('carries both kinds in one turn, in order', () => {
		const out = toAnthropicMessages(
			messages([
				{
					role: 'user',
					content: 'compare these',
					attachments: [
						{ data: 'iVBORw0KGgo=', mediaType: 'image/png' },
						{ type: 'document', data: 'JVBERi0xLjQK', mediaType: 'application/pdf' },
					],
				},
			]),
		)

		expect(blocksOf(out).map((b) => b.type)).toEqual(['text', 'image', 'document'])
	})

	it('omits the title when the attachment has no name', () => {
		const out = toAnthropicMessages(
			messages([
				{
					role: 'user',
					content: 'read it',
					attachments: [{ type: 'document', data: 'JVBERi0xLjQK', mediaType: 'application/pdf' }],
				},
			]),
		)

		expect(blocksOf(out)[1]).not.toHaveProperty('title')
	})
})
