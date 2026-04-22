import type { DoctorCheckResult } from '../doctor/index.js'

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

	/**
	 * Optional structured health probe used by `runDoctor()`.
	 *
	 * Returns a `DoctorCheckResult` with provider-specific detail
	 * (latency, model availability, auth status, …). Providers that
	 * cannot be cheaply probed should return `{ status: 'inconclusive' }`
	 * so the doctor doesn't mark them as failing — see ses_007 Q6.4.
	 */
	doctorCheck?(): Promise<DoctorCheckResult>
}
