import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toAnthropicMessages } from '../client.js'

/**
 * The document could be sent and the evidence could not come back, so an
 * answer about a contract arrived as prose and checking it meant reading
 * the contract again by hand.
 */

const messages = (list: unknown[]): ChatCompletionParams['messages'] =>
	list as ChatCompletionParams['messages']

const documentBlock = (attachment: Record<string, unknown>) => {
	const out = toAnthropicMessages(
		messages([{ role: 'user', content: 'summarise it', attachments: [attachment] }]),
	)
	const user = out.find((m) => m.role === 'user')
	const blocks = Array.isArray(user?.content) ? user.content : []
	return blocks.find((b) => b.type === 'document') as { citations?: { enabled: boolean } }
}

const PDF = { type: 'document', data: 'JVBERi0xLjQK', mediaType: 'application/pdf' }

describe('asking for citations on the way out', () => {
	it('enables them on the document when the attachment asked', () => {
		expect(documentBlock({ ...PDF, citations: true }).citations).toEqual({ enabled: true })
	})

	it('leaves them off otherwise', () => {
		// Not free: enabling it splits the document into citable units and
		// spends tokens on turns that never wanted a citation.
		expect(documentBlock(PDF)).not.toHaveProperty('citations')
	})
})
