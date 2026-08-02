import { describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * A thinking block's CLOSE was never emitted.
 *
 * `openReasoning` was declared, and read by the `content_block_stop`
 * branch, and never added to — three references in the whole file. So the
 * set was permanently empty, the close branch could not match, and
 * `reasoning: { done: true }` never reached the consumer. A host that
 * opens a thinking card on the first reasoning delta left it spinning for
 * the rest of the run.
 *
 * Stored blocks were unaffected, so replay always looked fine. It was only
 * the live stream that was broken, which is why it survived.
 */

async function* thinkingStream() {
	yield { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10 } } }
	yield {
		type: 'content_block_start',
		index: 0,
		content_block: { type: 'thinking', thinking: '' },
	}
	yield {
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'thinking_delta', thinking: 'weighing the options' },
	}
	yield {
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'signature_delta', signature: 'sig-abc' },
	}
	yield { type: 'content_block_stop', index: 0 }
	yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
	yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }
	yield { type: 'content_block_stop', index: 1 }
	yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }
	yield { type: 'message_stop' }
}

async function collectReasoning() {
	const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'test-model' })
	;(provider as never as { client: unknown }).client = {
		messages: { create: async () => thinkingStream() },
	}

	const reasoning: { index: number; done?: boolean; type?: string; signature?: string }[] = []
	for await (const chunk of provider.chatStream({
		model: 'test-model',
		messages: [{ role: 'user', content: 'think' }],
		maxTokens: 100,
	})) {
		const r = chunk.delta?.reasoning
		if (r) reasoning.push(r as never)
	}
	return reasoning
}

describe('a thinking block reports its close', () => {
	it('emits done: true when the block stops', async () => {
		const reasoning = await collectReasoning()
		expect(reasoning.some((r) => r.done === true)).toBe(true)
	})

	it('opens before it closes, and closes the block it opened', async () => {
		const reasoning = await collectReasoning()
		const opened = reasoning.findIndex((r) => r.type !== undefined)
		const closed = reasoning.findIndex((r) => r.done === true)

		expect(opened).toBeGreaterThanOrEqual(0)
		expect(closed).toBeGreaterThan(opened)
		expect(reasoning[closed]?.index).toBe(reasoning[opened]?.index)
	})

	it('still carries the signature, which replay depends on', async () => {
		const reasoning = await collectReasoning()
		expect(reasoning.some((r) => r.signature === 'sig-abc')).toBe(true)
	})

	it('closes exactly once', async () => {
		const reasoning = await collectReasoning()
		expect(reasoning.filter((r) => r.done === true)).toHaveLength(1)
	})
})
