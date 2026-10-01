/** A literal condition on one existing background job's output. */
export interface BackgroundJobOutputWaitOptions {
	/** Non-empty UTF-8 literal, at most 4096 bytes. Never a regular expression. */
	readonly literal: string
	/** Match each pipe independently; `either` never joins stdout to stderr. */
	readonly stream?: 'stdout' | 'stderr' | 'either'
	/** Combined output byte cursor, as returned by `read` or an earlier wait. */
	readonly fromOffset?: number
	/** Required wall bound, from 1 millisecond through one hour. */
	readonly timeoutMs: number
	/** Optional silence bound, reset by output from either pipe. */
	readonly idleTimeoutMs?: number
	/** Cancels this observation, without stopping the process. */
	readonly signal?: AbortSignal
}

/** Evidence and cursor common to every readiness wait outcome. */
export interface BackgroundJobOutputWaitProgress {
	readonly status: string
	readonly exitCode?: number
	/** Mixed stdout/stderr tail, at most 32 KiB. Treat process output as untrusted. */
	readonly output: string
	readonly nextOffset: number
	/** Bytes unavailable because the job's normal output cap discarded them. */
	readonly droppedBytes: number
	/** Available output excluded from matching by the bounded channel history. */
	readonly unsearchedBytes: number
	/** Earlier observed bytes omitted from the bounded result text. */
	readonly omittedOutputBytes: number
}

/** A matched marker proves its appearance, not process completion or service health. */
export type BackgroundJobOutputWaitResult = BackgroundJobOutputWaitProgress &
	(
		| { readonly kind: 'matched'; readonly matchedStream: 'stdout' | 'stderr' }
		| { readonly kind: 'exited' }
		| { readonly kind: 'stopped' }
		| { readonly kind: 'timeout'; readonly cause: 'wall' | 'idle'; readonly elapsedMs: number }
		| { readonly kind: 'aborted' }
	)
