import type { TokenUsage } from '../common/index.js'
import type { Message } from '../message/index.js'
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

	toolChoice?: ToolChoice
	parallelToolCalls?: boolean

	cacheControl?: CacheControl

	topP?: number
	topK?: number
	frequencyPenalty?: number
	presencePenalty?: number
	repetitionPenalty?: number

	responseFormat?: ResponseFormat

	/**
	 * Abort signal for the in-flight request. The runtime injects the run's
	 * signal on every attempt so a cancellation aborts the current call rather
	 * than only taking effect at the next iteration boundary. Providers that
	 * cannot forward it to their transport advertise `supportsAbortSignal:
	 * false` in their {@link ProviderCapabilities}.
	 */
	signal?: AbortSignal
}

export interface ChatCompletionResponse {
	id: string
	model: string
	message: {
		role: 'assistant'
		content: string | null
		toolCalls?: Array<{
			id: string
			type: 'function'
			function: {
				name: string
				arguments: string
			}
		}>
	}
	finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage: TokenUsage
}
