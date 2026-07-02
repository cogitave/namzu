import type { DoctorCheckResult } from '../doctor/index.js'

import type { ChatCompletionParams } from './chat.js'
import type { ProviderCapabilities } from './config.js'
import type { ModelInfo } from './model.js'
import type { StreamChunk } from './stream.js'

export interface LLMProvider {
	readonly id: string
	readonly name: string

	/**
	 * Honest declaration of what this DRIVER does with the request
	 * (tools passed through? attachments mapped?) — not what the vendor
	 * API supports. Optional so third-party providers that predate the
	 * field keep working: the runtime resolves an absent declaration to
	 * {@link import('../../provider/capabilities.js').PERMISSIVE_PROVIDER_CAPABILITIES},
	 * i.e. today's behavior (assume everything works, never warn).
	 */
	readonly capabilities?: ProviderCapabilities

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
