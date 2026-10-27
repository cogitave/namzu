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

/**
 * Providers that let the caller choose how long the prompt cache lives.
 *
 * Only a provider whose driver takes the setting; for every other one a
 * lifetime would be a number nobody chose and nothing honours, so it is not
 * shown.
 */
const PROVIDERS_WITH_CACHE_LIFETIME: ReadonlySet<string> = new Set(['anthropic'])

export function providerOffersCacheLifetime(providerId: string | null | undefined): boolean {
	return (
		providerId !== null && providerId !== undefined && PROVIDERS_WITH_CACHE_LIFETIME.has(providerId)
	)
}

/** The lifetime in use, as a person reads it. An unset value is the provider's own five minutes. */
export function describeCacheLifetime(ttl: PromptCacheTtl | undefined): string {
	return ttl === '1h' ? '1 hour' : '5 minutes'
}
