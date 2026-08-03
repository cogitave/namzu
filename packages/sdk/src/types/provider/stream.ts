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
		 * streaming arguments. Translates from whatever a provider uses to
		 * close a tool-use block, and from the equivalent
		 * end-of-tool-arguments boundary elsewhere.
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

		/**
		 * A passage the model is citing, as it arrives.
		 *
		 * Its own channel rather than a field on `content`, because a
		 * citation is not text the reader sees: it lands on the assistant
		 * message beside the prose. Drivers that cannot report one leave
		 * this undefined and the answer simply carries none.
		 */
		citation?: import('../message/index.js').Citation
	}
	finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage?: TokenUsage
	error?: string

	/**
	 * The call failed and is about to be retried after a backoff.
	 *
	 * Emitted by the retry decorator, never by a driver. It rides the
	 * stream because that is the only channel open while the decorator is
	 * sleeping: the consumer is blocked inside the provider's iterator, so
	 * an out-of-band callback could not reach it until the backoff was
	 * already over — which is exactly the window a host needs to be told
	 * about. A retry chunk carries no delta and must not be treated as
	 * output.
	 */
	retry?: ProviderRetryNotice
}

/** See {@link StreamChunk.retry}. */
export interface ProviderRetryNotice {
	/** 1-based attempt that just failed. */
	readonly attempt: number
	readonly maxRetries: number
	/** How long the decorator is about to sleep. */
	readonly delayMs: number
	/** Classified failure code, as `classifyProviderError` reports it. */
	readonly code: string
	readonly status?: number
	/** The delay came from the server's own `Retry-After`, not backoff. */
	readonly serverDirected: boolean
}
