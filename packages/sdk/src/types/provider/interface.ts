import type { DoctorCheckResult } from '../doctor/index.js'

import type { ChatCompletionParams } from './chat.js'
import type { ModelInfo } from './model.js'
import type { StreamChunk } from './stream.js'

export interface LLMProvider {
	readonly id: string
	readonly name: string

	/**
	 * The single LLM entry point. Returns an async iterable of
	 * {@link StreamChunk} carrying text deltas, tool-call argument
	 * fragments, and per-tool-block boundary signals (`toolCallEnd`).
	 *
	 * Consumers that need an aggregated response (legacy
	 * `ChatCompletionResponse` shape) call
	 * `collect(provider.chatStream(params))` from
	 * `@namzu/sdk/provider/collect`. The kernel's iteration
	 * orchestrator consumes the stream directly so it can emit
	 * per-delta `RunEvent`s.
	 *
	 * Phase 2 of ses_001-tool-stream-events removed the previous
	 * non-streaming `chat()` method from this interface.
	 */
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
