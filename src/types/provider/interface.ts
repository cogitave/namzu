import type { ChatCompletionParams, ChatCompletionResponse } from './chat.js'
import type { ModelInfo } from './model.js'
import type { StreamChunk } from './stream.js'

export interface LLMProvider {
	readonly id: string
	readonly name: string

	chat(params: ChatCompletionParams): Promise<ChatCompletionResponse>

	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk>

	listModels?(): Promise<ModelInfo[]>

	healthCheck?(): Promise<boolean>
}
