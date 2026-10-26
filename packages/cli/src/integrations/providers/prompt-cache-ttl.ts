/**
 * How long the model providers are asked to keep the prompt cache.
 *
 * One process-wide value, because providers are built in several places
 * (session start, token refresh, delegation, the provider chain) and none of
 * them has the settings in hand. The session sets it once from
 * `compaction.promptCacheTtl` before it builds its first provider; absent means
 * the provider's own default (five minutes), which is also what an unset value
 * does to a provider that has no lifetime to choose.
 */

export type PromptCacheTtl = '5m' | '1h'

let configured: PromptCacheTtl | undefined

export function setPromptCacheTtl(ttl: PromptCacheTtl | undefined): void {
	configured = ttl
}

export function promptCacheTtl(): PromptCacheTtl | undefined {
	return configured
}
