import type { TokenUsage } from '../types/common/index.js'

/** What the clock knows about the prompt cache after the latest model call. */
export interface CacheClockState {
	/** When the last call that touched the cache finished (ms since epoch). */
	readonly lastActivityAt: number
	/** How long the provider keeps the cache, as that call reported it. */
	readonly ttlMs: number
	/**
	 * When the cache lapses: `lastActivityAt + ttlMs`. Only set when the call
	 * actually read or wrote cache; a call that touched none leaves the cache
	 * (and so its expiry) unknown rather than assumed.
	 */
	readonly expiresAt: number | null
}

/**
 * Tracks when a conversation's prompt cache will lapse.
 *
 * Fed by each completed model call. The lifetime is never guessed: a call whose
 * usage carries no `cacheTtlMs` (a driver that does not report one) clears the
 * clock, so nothing downstream can act on a lifetime nobody stated. Pure of
 * timers: the caller passes `now`.
 */
export class CacheClock {
	#state: CacheClockState | null = null

	/** Record a finished call. `usage` is that call's own usage, not a turn total. */
	record(usage: TokenUsage, at: number): void {
		if (usage.cacheTtlMs === undefined || !(usage.cacheTtlMs > 0)) {
			this.#state = null
			return
		}
		const touched = usage.cachedTokens + usage.cacheWriteTokens > 0
		this.#state = {
			lastActivityAt: at,
			ttlMs: usage.cacheTtlMs,
			expiresAt: touched ? at + usage.cacheTtlMs : null,
		}
	}

	/** Forget everything (the conversation was replaced or its context rewritten). */
	reset(): void {
		this.#state = null
	}

	get state(): CacheClockState | null {
		return this.#state
	}

	/** Whether the cache is still alive at `now`. False when unknown. */
	warm(now: number): boolean {
		const state = this.#state
		return state !== null && state.expiresAt !== null && now < state.expiresAt
	}

	/**
	 * The moment `fraction` of the cache's remaining life since the last
	 * activity has passed: `lastActivityAt + (expiresAt - lastActivityAt) * fraction`.
	 * `null` when the expiry is unknown.
	 */
	dueAt(fraction: number): number | null {
		const state = this.#state
		if (state === null || state.expiresAt === null) return null
		return state.lastActivityAt + (state.expiresAt - state.lastActivityAt) * fraction
	}
}
