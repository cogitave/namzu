import type { TokenUsage } from '../common/index.js'

export interface StreamChunk {
	id: string
	delta: {
		content?: string
		toolCalls?: Array<{
			index: number
			id?: string
			type?: 'function'
			function?: {
				name?: string
				arguments?: string
			}
		}>
		/**
		 * Provider signal that a tool-use content block has finished
		 * streaming arguments. Translates from Anthropic's
		 * `content_block_stop` (for tool_use blocks) and from the
		 * equivalent end-of-tool-arguments boundary on other providers.
		 *
		 * The orchestrator uses this to emit `tool_input_completed` per
		 * tool as soon as its block closes, rather than waiting for
		 * `message_stop`. Providers that cannot emit a per-tool boundary
		 * leave this undefined; the orchestrator infers from
		 * end-of-stream instead.
		 *
		 * Added 2026-05-01 (ses_001-tool-stream-events A9).
		 */
		toolCallEnd?: {
			index: number
			id: string
		}
	}
	finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage?: TokenUsage
	error?: string
}
