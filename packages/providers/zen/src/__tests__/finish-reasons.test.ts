import { type Message, collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenProvider } from '../client.js'

/**
 * `@ai-sdk/anthropic`'s `mapAnthropicStopReason` folds both `max_tokens` and
 * `model_context_window_exceeded` into `unified: 'length'`, keeping the
 * original word only on `raw`. The driver used to read `unified` alone, so a
 * proxied Anthropic model that filled its context window reported a plain
 * `finishReason: 'length'`, indistinguishable from one that merely ran out
 * of output tokens — the runtime auto-continues that, sending a reply that
 * had just filled the window straight back in, in a prompt now longer than
 * the window it had just overflowed. See the equivalent fix in
 * `@namzu/lmstudio` (`contextLengthReached` vs `maxPredictedTokensReached`).
 */

const apiKey = 'opencode-finish-reason-test-secret'

afterEach(() => {
	vi.unstubAllGlobals()
})

function sse(frames: readonly unknown[]): string {
	return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

/** A minimal Anthropic-dialect (`protocol: 'messages'`) stream ending on `stopReason`. */
function anthropicFrames(stopReason: string): unknown[] {
	return [
		{
			type: 'message_start',
			message: {
				id: 'message-1',
				type: 'message',
				role: 'assistant',
				model: 'claude-haiku-4-5',
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 8, output_tokens: 0 },
			},
		},
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
		{ type: 'content_block_stop', index: 0 },
		{
			type: 'message_delta',
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 5 },
		},
		{ type: 'message_stop' },
	]
}

async function finishOf(stopReason: string) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(sse(anthropicFrames(stopReason)), {
					headers: { 'content-type': 'text/event-stream' },
				}),
		),
	)
	const provider = new ZenProvider({ apiKey, protocol: 'messages' }, 'zen')
	const messages: Message[] = [{ role: 'user', content: 'Hi' }]
	return collectChatCompletion(
		provider.chatStream({ model: 'claude-haiku-4-5', messages, maxTokens: 256 }),
	)
}

describe('Zen — a proxied backend context-window stop', () => {
	it("marks finishDetail: context_window when the raw stop reason is Anthropic's model_context_window_exceeded", async () => {
		const response = await finishOf('model_context_window_exceeded')
		expect(response.finishReason).toBe('length')
		expect(response.finishDetail).toBe('context_window')
	})

	it('gives no finishDetail for a plain output-limit length (max_tokens)', async () => {
		const response = await finishOf('max_tokens')
		expect(response.finishReason).toBe('length')
		expect(response.finishDetail).toBeUndefined()
	})

	it('gives no finishDetail to a normal finish, whatever it is called', async () => {
		const response = await finishOf('end_turn')
		expect(response.finishReason).toBe('stop')
		expect(response.finishDetail).toBeUndefined()
	})
})
