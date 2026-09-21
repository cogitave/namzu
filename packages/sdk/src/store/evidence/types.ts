/** @experimental An explicitly authorized session, or one turn of it. No directory discovery. */
export interface SessionEvidenceScope {
	readonly tenantId: string
	readonly projectId: string
	readonly sessionId: string
	/** Narrow to one turn. Absent: every turn of the session. */
	readonly turnId?: string
}

/** @experimental The session log must be private and host-owned. */
export interface SessionEvidenceSourceOptions {
	readonly scope: SessionEvidenceScope
	/** The session log (`<session-id>.jsonl`). */
	readonly logPath: string
	/** Optional smaller I/O ceiling per operation, in bytes (1–8 MiB). */
	readonly maxReadBytes?: number
	/**
	 * Readers default to a session with no active turn. Snapshot mode also
	 * reads a session whose turn is still running, checking the log head
	 * before and after every operation. Appends invalidate continuations and
	 * addresses. Results over an active turn remain incomplete even at the
	 * snapshot end.
	 */
	readonly consistency?: 'closed' | 'snapshot'
}

/** @experimental Literal search; empty query browses tool records. */
export interface SessionEvidenceSearchOptions {
	/** Optional per-call ceiling, 1–8 MiB. Cannot raise the source's own ceiling.
	 * Not part of search identity; a continuation may use a different allowance.
	 */
	readonly maxReadBytes?: number
	readonly query?: string
	/**
	 * Find passages matching any of 1–16 nonblank literal terms (up to 256 UTF-16
	 * units each) in the same bounded scan. Mutually exclusive with query, even
	 * an empty query. Exact duplicate terms and their order do not matter.
	 * This is candidate discovery, not relevance ranking or natural-language parsing.
	 */
	readonly terms?: readonly string[]
	/** With a cursor and its original token terms, continue at that position using
	 * a strict nonempty subset. Requires supportsTermRefinement. The returned
	 * cursor is bound to the subset; the original cursor remains usable.
	 */
	readonly refineTerms?: readonly string[]
	/**
	 * Defaults to literal substring matching. Token mode accepts only single
	 * Unicode letter/number/underscore tokens and matches complete tokens.
	 * Case-insensitive tokens use toLowerCase(), as bounded evidence ranking does.
	 * Empty-query browsing and phrases require literal mode. Bound into cursors.
	 */
	readonly matchMode?: 'literal' | 'token'
	/** Defaults to true. False uses the selected mode's case rules (see matchMode). */
	readonly caseSensitive?: boolean
	/**
	 * Omit successful results from these exact tool names during search. At most
	 * 16 names, each 1–256 UTF-16 units. Errors and unknown provenance remain.
	 * Bound into cursors; exact reads are unchanged. Default: exclude nothing.
	 */
	readonly excludeSuccessfulTools?: readonly string[]
	readonly cursor?: string
}

/** @experimental Opaque addresses remain usable after restart while the source is unchanged. */
export interface SessionEvidenceMatch {
	readonly address: string
	readonly seq: number
	/** Stored event wall-clock Unix milliseconds; absent/invalid/zero stamps remain unknown.
	 * This dates archive recording, not the facts in its text. Clocks can differ or move backwards.
	 */
	readonly recordedAt?: number
	readonly toolName: string
	readonly isError: boolean
	readonly retained: 'full' | 'preview'
	readonly excerpt: string
	/** True only when the excerpt contains the whole full-retained text part.
	 * False includes partial text and retained previews; absent is unknown.
	 * This says nothing about other parts, scan completeness or source truth.
	 */
	readonly excerptComplete?: boolean
	readonly byteOffset: number
}

/** @experimental An empty bounded page does not imply absence. Follow nextCursor. */
export interface SessionEvidenceSearchResult {
	readonly scope: SessionEvidenceScope
	readonly matches: readonly SessionEvidenceMatch[]
	readonly nextCursor: string | null
	readonly scannedBytes: number
	readonly indexedRecords: number
	readonly cacheHit: boolean
	readonly incomplete: boolean
	readonly unavailable: readonly string[]
	/** Successful tool-result visits omitted by this page's filter; not unique facts. */
	readonly excludedToolResults?: number
}

/** @experimental Byte offsets refer to UTF-8 retained text, not the current workspace file. */
export interface SessionEvidenceReadOptions {
	readonly address: string
	readonly byteOffset?: number
	/** Optional per-call ceiling, 1–8 MiB, capped by the source's own ceiling. */
	readonly maxReadBytes?: number
}

/** @experimental Full means retained text, not binary blocks or proof an action succeeded. */
export interface SessionEvidenceReadResult {
	readonly scope: SessionEvidenceScope
	readonly seq: number
	/** Same stored-event wall-clock semantics as SessionEvidenceMatch.recordedAt. */
	readonly recordedAt?: number
	readonly toolName: string
	readonly isError: boolean
	readonly retained: 'full' | 'preview'
	readonly text: string
	readonly byteOffset: number
	readonly nextByteOffset: number | null
	readonly totalBytes: number
	readonly scannedBytes: number
}

/** @experimental Retrieval only: never re-executes a tool or resumes a turn. */
export interface SessionEvidenceSource {
	readonly scope: SessionEvidenceScope
	readonly supportsTermRefinement?: boolean
	search(
		options?: SessionEvidenceSearchOptions,
		signal?: AbortSignal,
	): Promise<SessionEvidenceSearchResult>
	read(
		options: SessionEvidenceReadOptions,
		signal?: AbortSignal,
	): Promise<SessionEvidenceReadResult>
}

/** @experimental Textual event parts, including assistant output and shed conversation messages. */
export interface SessionTextEvidenceSearchOptions extends SessionEvidenceSearchOptions {
	/** Omit explicitly marked derived summaries. Default false; bound into cursors. Exact reads remain available. */
	readonly excludeDerivedSummaries?: boolean
	readonly seq?: number
	readonly part?: number
	readonly limit?: number
}

/** @experimental Event identity is durable; byteOffset starts a bounded excerpt in the retained text. */
export interface SessionTextEvidenceMatch
	extends Omit<SessionEvidenceMatch, 'toolName' | 'isError'> {
	readonly source: string
	readonly part: number
	readonly toolName?: string
	readonly isError?: boolean
	/** UTF-16 position, when the authenticated source includes a character index. */
	readonly characterOffset?: number
}

/** @experimental Search includes messages and tool text, never binary or private reasoning blocks. */
export interface SessionTextEvidenceSearchResult
	extends Omit<SessionEvidenceSearchResult, 'matches'> {
	readonly matches: readonly SessionTextEvidenceMatch[]
	/** Derived-summary part visits deliberately skipped, not unique facts or matched passages. */
	readonly excludedSummaries?: number
}

/** @experimental Character counts are UTF-16 units; absent counts must not be inferred from bytes. */
export interface SessionTextEvidenceReadResult
	extends Omit<SessionEvidenceReadResult, 'toolName' | 'isError'> {
	readonly source: string
	readonly part: number
	readonly toolName?: string
	readonly isError?: boolean
	readonly characterOffset?: number
	readonly totalChars?: number
}

/** @experimental Scope-bound, bounded text retrieval across a session log. */
export interface SessionTextEvidenceSource {
	readonly scope: SessionEvidenceScope
	readonly supportsTermRefinement?: boolean
	search(
		options?: SessionTextEvidenceSearchOptions,
		signal?: AbortSignal,
	): Promise<SessionTextEvidenceSearchResult>
	read(
		options: SessionEvidenceReadOptions,
		signal?: AbortSignal,
	): Promise<SessionTextEvidenceReadResult>
}
