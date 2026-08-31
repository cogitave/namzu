import type { LLMProvider } from './interface.js'

/**
 * Registry of provider config shapes keyed by provider type string.
 *
 * Third-party provider packages extend this interface via TypeScript module
 * augmentation. Each key in the registry becomes a valid `ProviderType`, and
 * consumers of `ProviderRegistry.create({ type: 'X', ... })` get discriminated
 * union narrowing to the correct config shape.
 *
 * @example
 * ```ts
 * // @namzu/bedrock package
 * declare module '@namzu/sdk' {
 *   interface ProviderConfigRegistry {
 *     bedrock: BedrockProviderConfig
 *   }
 * }
 * ```
 */
export interface ProviderConfigRegistry {
	mock: MockProviderConfig
}

export type ProviderType = keyof ProviderConfigRegistry & string

export type ProviderFactoryConfig = {
	[K in ProviderType]: ProviderConfigRegistry[K]
}[ProviderType]

/** One scripted tool call within a {@link MockTurn}. */
export interface MockToolCall {
	name: string
	/** Serialized to JSON and streamed in fragments. */
	args?: Record<string, unknown>
	/** Defaults to a deterministic `call_<turn>_<index>`. */
	id?: string
	/** Fragment size for the argument JSON; smaller exercises more buffering. */
	argChunkSize?: number
	/**
	 * Omit the block-close signal and stop mid-JSON, reproducing the
	 * provider cutting a tool call off at `max_tokens`. The consumer should
	 * mark the call `inputTruncated` rather than crashing on a parse.
	 */
	truncateArguments?: boolean
	/**
	 * Emit this raw string as the argument payload instead of serializing
	 * `args`. For scripting malformed or partial JSON the model could
	 * plausibly produce.
	 */
	rawArguments?: string
	/**
	 * Throw after the argument fragments, mid-tool-block.
	 *
	 * This is the failure the truncated-tool-input recovery path exists
	 * for — a provider going idle while streaming tool JSON — so it has to
	 * be scriptable, or that path can only be tested by hand-rolling a
	 * provider.
	 */
	throwAfterArguments?: string
}

/** One assistant turn the mock provider plays. */
export interface MockTurn {
	text?: string
	toolCalls?: MockToolCall[]
	/** Passages this scripted turn cites, emitted before its text. */
	citations?: import('../message/index.js').Citation[]
	finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage?: Partial<import('../common/index.js').TokenUsage>
	/** Text fragment size. */
	chunkSize?: number
	/** Fail the request outright, before any chunk — e.g. a 429. */
	error?: { message: string; status?: number }
	/** Fail mid-stream after N text chunks, to exercise recovery paths. */
	throwAfterChunks?: number
	throwMessage?: string
}

/**
 * The scripted behavior itself, without the registry discriminant, so a
 * test can `new MockLLMProvider({ turns: [...] })` directly.
 */
export interface MockScript {
	model?: string
	/** Shorthand for a single text-only turn. */
	responseText?: string
	responseDelayMs?: number
	/**
	 * Scripted turns. A script shorter than the run repeats its last entry,
	 * so a loop bug shows up as repetition rather than a crash.
	 */
	turns?: MockTurn[]
	/** Full control: decide each turn from the request that triggered it. */
	nextTurn?: (params: import('./chat.js').ChatCompletionParams, turnIndex: number) => MockTurn
	/**
	 * Override the capability declaration for this instance.
	 *
	 * Capability negotiation degrades a run when a driver says it cannot do
	 * something, and testing that path means being able to SAY it — a fixed
	 * registry-level declaration cannot express "a driver with no vision".
	 */
	capabilities?: ProviderCapabilities
	/** Observe every request (assert on tools, toolChoice, cacheControl…). */
	onRequest?: (params: import('./chat.js').ChatCompletionParams) => void
}

export interface MockProviderConfig extends MockScript {
	type: 'mock'
}

/**
 * What a provider DRIVER actually does with the request — not what the
 * vendor API could theoretically support. A driver that never reads
 * `params.tools` declares `supportsTools: false` even if the backing
 * service has a tools endpoint; a driver that drops `attachments`
 * declares `supportsVision: false` even for a multimodal model.
 *
 * The query runtime consults these before each run (see
 * `resolveProviderCapabilities` in `provider/capabilities.ts`) so
 * degradation is loud instead of silent.
 */
export interface ProviderCapabilities {
	supportsTools: boolean
	supportsStreaming: boolean
	supportsFunctionCalling: boolean
	/**
	 * Whether the driver maps user-message image `attachments` into the
	 * provider request. Optional for compatibility with pre-existing
	 * declarations: absent ⇒ treated as vision-capable (permissive
	 * default — the runtime only warns when a driver explicitly says no).
	 */
	supportsVision?: boolean
	/**
	 * Whether the driver maps user-message DOCUMENT attachments into the
	 * provider request. Separate from vision because the two are separate
	 * wire shapes and a driver can map one without the other. Absent ⇒
	 * treated as capable, same permissive default.
	 */
	supportsDocuments?: boolean
	/**
	 * Whether the driver maps image blocks returned by tools onto its tool-result
	 * wire. Separate from `supportsVision`: some protocols admit user image input
	 * but only text in a function result. Absent keeps the permissive compatibility
	 * default used by the older flags.
	 */
	supportsToolResultImages?: boolean
	/** Whether the driver maps document blocks returned by tools onto its result wire. */
	supportsToolResultDocuments?: boolean
	maxOutputTokens?: number
}

export interface ProviderFactoryResult {
	provider: LLMProvider
	capabilities: ProviderCapabilities
}

export interface RegisterOptions {
	/** When true, replace an existing registration. Default false → throw on duplicate. */
	replace?: boolean
}

/**
 * What a lazy loader must resolve to: a factory that constructs the
 * provider, plus (optionally) the provider package's authoritative
 * capability declaration resolved at load time.
 *
 * Designed so a host can map a dynamic import in one line:
 *
 * ```ts
 * ProviderRegistry.registerLazy('anthropic', async () => {
 *   const m = await import('@namzu/anthropic')
 *   return { create: (c) => new m.AnthropicProvider(c), capabilities: m.ANTHROPIC_CAPABILITIES }
 * })
 * ```
 */
export interface LazyProviderModule<C = unknown> {
	create: (config: C) => LLMProvider
	/**
	 * Authoritative type-level capabilities shipped by the loaded module.
	 * When present, replaces any registration-time hint in the registry.
	 */
	capabilities?: ProviderCapabilities
}

export type LazyProviderLoader<C = unknown> = () => Promise<LazyProviderModule<C>>

export interface RegisterLazyOptions extends RegisterOptions {
	/**
	 * Pre-load capability HINT so `ProviderRegistry.getCapabilities(type)`
	 * can answer without triggering the loader. Precedence (weakest first):
	 * this hint → the loaded module's `capabilities` → the constructed
	 * instance's own `LLMProvider.capabilities` (what the query runtime
	 * resolves via `resolveProviderCapabilities` and actually respects).
	 */
	capabilities?: ProviderCapabilities
}

export type LLMProviderConstructor<C = unknown> = new (config: C) => LLMProvider
