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
	 * Retry behaviour this DRIVER wants, when the generic default is wrong
	 * for the vendor behind it.
	 *
	 * One config was applied to every member of a chain, so an operator
	 * running [expensive primary, cheap self-hosted backup] could not give
	 * the backup a shorter budget — the two have different failure shapes
	 * and different costs per attempt, and only the driver knows which.
	 *
	 * Merged UNDER a caller's config, never over it: the host asked for
	 * something specific and the driver is expressing a default. Absent
	 * means the generic default, which is what every driver had before this
	 * existed.
	 */
	readonly retryDefaults?: Partial<import('../../provider/retry.js').ProviderRetryConfig>

	/**
	 * The single LLM entry point. Returns an async iterable of
	 * {@link StreamChunk} carrying text deltas, tool-call argument
	 * fragments, and per-tool-block boundary signals (`toolCallEnd`).
	 *
	 * Consumers that need an aggregated response (legacy
	 * `ChatCompletionResponse` shape) call
	 * `collectChatCompletion(provider.chatStream(params))` from
	 * `@namzu/sdk/provider/collect-chat-completion`. The kernel's iteration
	 * orchestrator consumes the stream directly so it can emit
	 * per-delta `RunEvent`s.
	 *
	 * Phase 2 of ses_001-tool-stream-events removed the previous
	 * non-streaming `chat()` method from this interface.
	 */
	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk>

	/** Optional cancellation belongs to the surface asking for this menu. */
	listModels?(signal?: AbortSignal): Promise<ModelInfo[]>

	/**
	 * Establish whether this credential actually works. Resolves if it does,
	 * throws if it does not.
	 *
	 * Separate from `listModels` because the two answer different questions, and
	 * conflating them is a defect measured rather than imagined. `listModels`
	 * builds a MENU: "what can I offer this operator to choose from?" — a stale
	 * hardcoded list is a degraded but legitimate answer, since someone offline
	 * still has to pick a model. This builds a PROBE: "did this key work?" — and
	 * for that a list is not a degraded answer, it is no answer, because it
	 * arrives whether the key is right, wrong, expired or never sent.
	 *
	 * Two drivers proved a menu cannot stand in for a probe, and they failed
	 * differently. One caught a real `401` and returned its hardcoded catalogue,
	 * so the truth existed and was thrown away. The other has no fallback at all
	 * and is entirely honest about its menu — its listing endpoint simply does
	 * not authenticate, so ANY string returned the real catalogue. That second
	 * case is why this is a separate method rather than a rule about writing
	 * `listModels` more carefully: no amount of care in a menu makes it a probe.
	 *
	 * The probe is per-driver by nature — one has an authenticated call whose
	 * failure is real, another needs a different endpoint than its menu — so it
	 * is DECLARED, never inferred. A driver that does not implement this is
	 * reported as unverifiable, never as verified, and that has to hold for the
	 * driver nobody has written yet: inheriting a generic path silently is how
	 * this defect returns.
	 *
	 * Throw so the caller can tell the two failures apart. A rejection from the
	 * server (`401`/`403`) means the credential is genuinely bad; anything else
	 * — a timeout, DNS, a proxy — means nothing was learned, and reporting that
	 * as a bad key would tell an operator on broken wifi to go and rotate a
	 * credential that is fine.
	 */
	probeCredential?(signal?: AbortSignal): Promise<void>

	/**
	 * Is this driver able to serve traffic? A summary bit; `doctorCheck` is
	 * the same probe with its reasoning intact.
	 *
	 * `model` is the model the CALLER intends to run, and it is a parameter
	 * rather than something the driver reads off its own config because at
	 * least one driver's config does not carry a model at all. That driver
	 * hardcoded an id instead, which is how its check came to probe a model
	 * nobody used — and, once the id went stale, could not pass at any
	 * credential, region or service state. A health check against a model the
	 * operator does not run tests the wrong thing even while the id is valid.
	 *
	 * Optional, and a driver may ignore it: one that probes an endpoint rather
	 * than a model has nothing to do with the argument. Passing it is always
	 * safe.
	 */
	healthCheck?(model?: string): Promise<boolean>

	/**
	 * Optional structured health probe used by `runDoctor()`.
	 *
	 * Returns a `DoctorCheckResult` with provider-specific detail
	 * (latency, model availability, auth status, …). Providers that
	 * cannot be cheaply probed should return `{ status: 'inconclusive' }`
	 * so the doctor doesn't mark them as failing — see ses_007 Q6.4.
	 *
	 * Takes `model` for the reason `healthCheck` does, and a driver is free to
	 * return a SUBTYPE of `DoctorCheckResult` carrying its own machine-readable
	 * detail. `status` is what `runDoctor()` reads; a caller holding the
	 * concrete driver can read more.
	 */
	doctorCheck?(model?: string): Promise<DoctorCheckResult>

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

	/**
	 * How large a context this model actually has, if the vendor says.
	 *
	 * The kernel's only source below an explicit host config is a
	 * hand-maintained prefix table, and its own header records what that
	 * costs: one vendor family's entries all carried 200k including the
	 * models whose window is 1M, so those runs compacted at roughly 14% full
	 * and threw away the prompt-cache prefix to do it. Every model release drifts the table
	 * again until somebody edits it. Meanwhile at least one driver already
	 * parses a real per-model `context_length` off the vendor listing and
	 * throws it away, because there was no member to return it through.
	 *
	 * Three states, exactly like {@link LLMProvider.effortLevelsFor}: the
	 * member ABSENT means this driver cannot answer at all; a resolved
	 * `undefined` means it asked and does not know; a number is the answer.
	 * The three are different facts and collapsing any two of them turns
	 * "I do not know" into a confident wrong number, which is the failure
	 * the table already made once.
	 *
	 * Resolved ONCE per run, not per iteration — the two consumers are
	 * synchronous and in the hot loop, so this must never become an await
	 * inside it. A rejection or a hang here is not a run failure: the table
	 * is still there, and a driver that cannot answer must not take down a
	 * run that would otherwise work.
	 */
	resolveContextWindow?(model: string, signal?: AbortSignal): Promise<number | undefined>
}
