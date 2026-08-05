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

	/**
	 * Which {@link ChatCompletionParams.effort} levels this model accepts,
	 * under the thinking configuration you intend to send with it.
	 *
	 * Asked rather than assumed because effort is **refused, not clamped**:
	 * a level a model does not have makes the vendor reject the request, so a
	 * caller offering a choice it cannot honour produces a run that fails at
	 * the start rather than a quieter one. Building that choice needs the
	 * answer BEFORE the request exists.
	 *
	 * There are three states and they mean different things:
	 *
	 * - **method absent** — this driver has no effort concept at all. Setting
	 *   `effort` on a run using it is refused, not ignored, so a caller should
	 *   offer no control rather than a disabled one.
	 * - **empty array** — the driver implements effort and THIS model has no
	 *   levels. A real answer, not a missing one.
	 * - **non-empty** — offer exactly these, and nothing else.
	 *
	 * `thinking` is a parameter rather than the caller reading two sibling
	 * arrays, and that is the whole reason this is a function. At least one
	 * model family accepts a narrower set of levels while thinking is
	 * disabled than while it is on, so an API returning both sets invites a
	 * caller to render a picker from one and then send the other — a
	 * combination the vendor rejects, on exactly one family, discovered in
	 * production. Passing the configuration you are actually going to send
	 * makes that mistake unspellable: there is one answer and it is the one
	 * for your request.
	 *
	 * The levels are not stable across models and have moved twice already,
	 * so a caller must not copy the answer into its own table. A copy goes
	 * stale on the next model release and goes stale SILENTLY — surfacing as
	 * a vendor rejection rather than a failing build.
	 */
	effortLevelsFor?(
		model: string,
		thinking?: import('./chat.js').ThinkingConfig,
	): readonly import('./chat.js').ReasoningEffort[]
}
