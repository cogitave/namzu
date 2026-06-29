import type { TokenUsage } from '../common/index.js'
import type { Message, ToolCall } from '../message/index.js'
import type { LLMToolSchema } from '../tool/index.js'

export type ToolChoice =
	| 'auto'
	| 'none'
	| 'required'
	| { type: 'function'; function: { name: string } }

export type ResponseFormat =
	| { type: 'json_object' }
	| {
			type: 'json_schema'
			json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean }
	  }

export interface CacheControl {
	type: 'auto' | 'ephemeral'
}

export interface ChatCompletionParams {
	model: string
	messages: Message[]
	tools?: LLMToolSchema[]
	temperature?: number
	maxTokens?: number
	stream?: boolean
	stop?: string[]

	/**
	 * Per-call cancellation. Aborting it tears down the in-flight model
	 * request (the provider passes it to the underlying fetch / SDK) AND the
	 * runtime races the stream consumer against it, so a Stop stops the
	 * CURRENT turn mid-flight — not only between turns. Optional and inert
	 * when unset: a non-aborted signal is behaviourally identical to omitting
	 * it, so existing callers are unaffected.
	 */
	signal?: AbortSignal

	toolChoice?: ToolChoice
	parallelToolCalls?: boolean

	cacheControl?: CacheControl

	topP?: number
	topK?: number
	frequencyPenalty?: number
	presencePenalty?: number
	repetitionPenalty?: number

	responseFormat?: ResponseFormat
}

export interface ChatCompletionResponse {
	id: string
	model: string
	message: {
		role: 'assistant'
		content: string | null
		toolCalls?: ToolCall[]
	}
	finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage: TokenUsage
}
