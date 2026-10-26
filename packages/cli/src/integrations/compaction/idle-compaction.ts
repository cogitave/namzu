/**
 * Compact a conversation nobody is using, before its prompt cache lapses.
 *
 * A one-hour cache is paid for once and read cheaply for an hour. When the
 * person leaves a large conversation and comes back after the cache is gone,
 * the whole context is written again at full price. Compacting it just before
 * the cache expires means the return pays to re-read a small context instead.
 *
 * Armed after every finished turn, once, at 90% of the cache's life since its
 * last activity (a late-armed timer is not retried). It acts only when it is
 * still true at that moment that:
 *
 * - the setting is on and compaction is not switched off;
 * - the conversation and model are the ones it was armed for;
 * - the cache is a one-hour cache, still warm, and the timer is no more than a
 *   minute late (a sleeping laptop wakes up long after the cache is gone);
 * - the context has at least `minTokens` in it;
 * - no request has been sent since the turn ended;
 * - the provider reports no rate-limit pressure;
 * - no turn, dialog, background work or queued message exists, and the person
 *   has not touched the keyboard for a minute.
 *
 * A skipped or failed attempt is invisible; only a success is reported.
 * Pure of React and the terminal: clock, timers and the model call are handed
 * in, so a test advances time itself.
 */

import { CacheClock, type TokenUsage } from '@namzu/sdk'

/** Smallest context worth the call, and the floor an override cannot go under. */
export const IDLE_COMPACTION_DEFAULT_MIN_TOKENS = 200_000
export const IDLE_COMPACTION_MIN_TOKENS_FLOOR = 100_000
/** How far into the cache's life the attempt is made. */
export const IDLE_COMPACTION_FIRE_AT = 0.9
/** How late the timer may run before the cache is presumed gone. */
export const IDLE_COMPACTION_LATENESS_MS = 60_000
/** How long the person must have been away from the keyboard. */
export const IDLE_COMPACTION_PRESENCE_MS = 60_000
const ONE_HOUR_MS = 3_600_000

/** The configured minimum, floored; an unusable value falls back to the default. */
export function resolveIdleCompactionMinTokens(
	...candidates: readonly (number | string | undefined)[]
): number {
	for (const candidate of candidates) {
		const value = typeof candidate === 'string' ? Number(candidate.trim()) : candidate
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			return Math.max(IDLE_COMPACTION_MIN_TOKENS_FLOOR, Math.floor(value))
		}
	}
	return IDLE_COMPACTION_DEFAULT_MIN_TOKENS
}

export type IdleCompactionSkip =
	| 'disabled'
	| 'conversation-changed'
	| 'lapsed'
	| 'late'
	| 'small'
	| 'newer-request'
	| 'near-limit'
	| 'busy'
	| 'present'

export interface IdleCompactorDeps {
	readonly now: () => number
	readonly setTimer: (run: () => void, ms: number) => unknown
	readonly clearTimer: (handle: unknown) => void
	/** The setting and compaction as a whole are on. Read at fire time. */
	readonly isEnabled: () => boolean
	/** Names the conversation and model; a change since arming cancels the attempt. */
	readonly conversationKey: () => string
	readonly minTokens: () => number
	/** The context size now, or undefined when it is not known. */
	readonly contextTokens: () => number | undefined
	/** True when the provider has said the person is close to a usage limit. */
	readonly isNearLimit: () => boolean
	readonly lastInteractionAt: () => number
	readonly isTurnRunning: () => boolean
	readonly isDialogOpen: () => boolean
	readonly hasPendingWake: () => boolean
	readonly hasBackgroundWork: () => boolean
	/** Run the compaction. Resolves true when something was compacted. Never retried. */
	readonly compact: () => Promise<boolean>
	/** Told how an attempt ended, for a debug log; never shown. */
	readonly report?: (
		outcome: 'compacted' | 'nothing-to-compact' | 'failed' | IdleCompactionSkip,
	) => void
}

export class IdleCompactor {
	readonly #deps: IdleCompactorDeps
	readonly #clock = new CacheClock()
	#timer: unknown = null
	#armedKey: string | null = null
	#dueAt = 0
	#requestSinceArming = false
	#running = false
	#disposed = false

	constructor(deps: IdleCompactorDeps) {
		this.#deps = deps
	}

	/**
	 * A model call finished. `cache` is what the call reported about the prompt
	 * cache, absent for a driver that reports none (which clears the clock, so
	 * nothing is ever armed for a lifetime nobody stated).
	 */
	recordCall(cache: { ttlMs: number; touched: boolean } | undefined): void {
		if (cache === undefined) {
			this.#clock.reset()
			return
		}
		const usage: TokenUsage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: cache.touched ? 1 : 0,
			cacheWriteTokens: 0,
			cacheTtlMs: cache.ttlMs,
		}
		this.#clock.record(usage, this.#deps.now())
	}

	/** A request is about to be sent: whatever was armed is now out of date. */
	requestStarted(): void {
		this.#requestSinceArming = true
	}

	/** The context was replaced or rewritten: the cache no longer matches it. */
	contextChanged(): void {
		this.#clock.reset()
		this.#cancel()
	}

	/** A turn finished, whatever its outcome: arm once for this cache. */
	turnSettled(): void {
		if (this.#disposed) return
		this.#cancel()
		this.#requestSinceArming = false
		if (!this.#deps.isEnabled()) return
		const state = this.#clock.state
		if (state === null || state.ttlMs !== ONE_HOUR_MS) return
		const due = this.#clock.dueAt(IDLE_COMPACTION_FIRE_AT)
		if (due === null) return
		this.#armedKey = this.#deps.conversationKey()
		this.#dueAt = due
		this.#timer = this.#deps.setTimer(
			() => {
				this.#timer = null
				void this.#fire()
			},
			Math.max(0, due - this.#deps.now()),
		)
	}

	dispose(): void {
		this.#disposed = true
		this.#cancel()
	}

	#cancel(): void {
		if (this.#timer === null) return
		this.#deps.clearTimer(this.#timer)
		this.#timer = null
	}

	/** First failing reason wins; null means go. */
	#decide(): IdleCompactionSkip | null {
		const deps = this.#deps
		const now = deps.now()
		if (!deps.isEnabled()) return 'disabled'
		if (deps.conversationKey() !== this.#armedKey) return 'conversation-changed'
		const state = this.#clock.state
		if (state === null || state.ttlMs !== ONE_HOUR_MS || !this.#clock.warm(now)) return 'lapsed'
		if (now - this.#dueAt > IDLE_COMPACTION_LATENESS_MS) return 'late'
		const tokens = deps.contextTokens()
		if (tokens === undefined || tokens < deps.minTokens()) return 'small'
		if (this.#requestSinceArming) return 'newer-request'
		if (deps.isNearLimit()) return 'near-limit'
		if (
			this.#running ||
			deps.isTurnRunning() ||
			deps.isDialogOpen() ||
			deps.hasPendingWake() ||
			deps.hasBackgroundWork()
		)
			return 'busy'
		if (now - deps.lastInteractionAt() < IDLE_COMPACTION_PRESENCE_MS) return 'present'
		return null
	}

	async #fire(): Promise<void> {
		const skip = this.#decide()
		if (skip !== null) {
			this.#deps.report?.(skip)
			return
		}
		this.#running = true
		try {
			const compacted = await this.#deps.compact()
			this.#deps.report?.(compacted ? 'compacted' : 'nothing-to-compact')
		} catch {
			this.#deps.report?.('failed')
		} finally {
			this.#running = false
		}
	}
}

/** The row a successful idle compaction leaves in the transcript. */
export const IDLE_COMPACTION_NOTICE =
	'Compacted while idle, before the prompt cache expired · turn off with "idleCompaction": false under "compaction" in the config'
