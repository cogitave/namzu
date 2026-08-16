/**
 * Old spellings of renamed exports, kept alive for one deprecation window.
 *
 * SemVer's guidance, and this repo's rule, is that a removal is preceded by
 * at least one minor release carrying the deprecation — so a consumer has a
 * version where their code still compiles and warns. These are that version.
 * Nothing in this tree imports from here; every in-tree call site moved to
 * the new name in the same commit that added it, because an alias that the
 * kernel itself still uses is not a deprecation, it is a second name.
 *
 * **Why each pair is written as a `const` plus a `type` rather than
 * `export { New as Old }`.** The re-export form cannot carry a JSDoc tag on
 * the alias: the tag lands on the original declaration or nowhere, so
 * `Registry` would ship with no `@deprecated` marker at all. Nothing would
 * fail — a consumer's editor simply would not strike it through, and the
 * public-surface gate's `deprecated` view would not list it, which is the
 * one place a reviewer looks to confirm a window is actually open. Declaring
 * the pair explicitly puts the tag on a declaration of our own, and the two
 * declarations merge across the value and type namespaces so a name used as
 * both — every class here — keeps working in both positions.
 *
 * So: do not "simplify" these to `export { X as Y }`. It compiles, it passes
 * the tests, and it silently empties the deprecated view.
 */

import { AuthorizationGate } from './authorization/gate.js'
import { collectChatCompletion } from './provider/collect-chat-completion.js'
import { BaseRegistry } from './registry/BaseRegistry.js'
import { PromptCache, type PromptCacheConfig } from './runtime/query/prompt-cache.js'
import { LocalTaskScheduler } from './scheduler/local.js'

/**
 * @deprecated Renamed to {@link collectChatCompletion}. Removed in the next
 * major. The old name said nothing about what it collects; it drains a
 * `StreamChunk` iterable into a `ChatCompletionResponse`.
 */
export const collect = collectChatCompletion

/**
 * @deprecated Renamed to {@link BaseRegistry}. Removed in the next major.
 * The bare name read as the general-purpose registry while sitting beside
 * seven domain-qualified siblings in the same barrel; it is the base class.
 */
export const Registry = BaseRegistry
/**
 * @deprecated Renamed to {@link BaseRegistry}. Removed in the next major.
 */
export type Registry<TDefinition> = BaseRegistry<TDefinition>

/**
 * @deprecated Renamed to {@link PromptCache}. Removed in the next major. The
 * cluster named one input two ways a single call apart —
 * `new ContextCache(ContextCacheConfig)` then `.getSystemPrompt(PromptCacheInput)`.
 */
export const ContextCache = PromptCache
/**
 * @deprecated Renamed to {@link PromptCache}. Removed in the next major.
 */
export type ContextCache = PromptCache

/**
 * @deprecated Renamed to {@link PromptCacheConfig}. Removed in the next major.
 */
export type ContextCacheConfig = PromptCacheConfig

/**
 * @deprecated Renamed to {@link LocalTaskScheduler}. Removed in the next
 * major. It schedules in-process agent tasks; it is not a facade over
 * anything external, which is what "gateway" told a reader to expect.
 */
export const LocalTaskGateway = LocalTaskScheduler
/**
 * @deprecated Renamed to {@link LocalTaskScheduler}. Removed in the next major.
 */
export type LocalTaskGateway = LocalTaskScheduler

/**
 * @deprecated Renamed to {@link AuthorizationGate}. Removed in the next
 * major. It decides whether a tool call is permitted before the call runs;
 * it does not verify anything after the fact.
 */
export const VerificationGate = AuthorizationGate
/**
 * @deprecated Renamed to {@link AuthorizationGate}. Removed in the next major.
 */
export type VerificationGate = AuthorizationGate
