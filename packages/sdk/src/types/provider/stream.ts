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

		/**
		 * A fragment of a reasoning block.
		 *
		 * There was no channel for this at all, so `thinking_delta` and
		 * `signature_delta` fell through the driver's `default: // ignore`
		 * and the blocks could not be stored even in principle — which is
		 * what made the verbatim-echo contract unsatisfiable and left the
		 * streaming UI with a multi-second stall and zero events.
		 *
		 * `index` groups fragments belonging to the same block, exactly as
		 * `toolCalls[].index` does. `done` closes it.
		 */
		reasoning?: {
			index: number
			type?: 'thinking' | 'redacted_thinking'
			text?: string
			/** Arrives once, at the end of the block. */
			signature?: string
			/** Opaque payload for a redacted block. */
			encrypted?: string
			done?: boolean
		}
	}
	finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage?: TokenUsage
	error?: string
}
