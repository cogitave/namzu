/** @experimental An explicitly authorized invocation. No directory discovery. */
export interface RunEvidenceScope {
	readonly tenantId: string
	readonly projectId: string
	readonly sessionId: string
	readonly runId: string
}

/** @experimental Cache and run directories must be private and host-owned. */
export interface DiskRunEvidenceOptions {
	readonly scope: RunEvidenceScope
	readonly runDir: string
	readonly indexDir: string
	/** Optional smaller I/O ceiling per operation, in bytes (1–8 MiB). */
	readonly maxReadBytes?: number
	/**
	 * Disk readers default to closed runs. Snapshot mode also reads explicitly
	 * scoped nonterminal runs, checking file/metadata stamps before and after
	 * every operation. It neither claims a writer is dead nor resumes it.
	 * Appends or metadata changes invalidate continuations and addresses.
	 * Nonterminal search results remain incomplete even at the snapshot end.
	 * An incomplete final JSONL fragment is excluded without changing the file;
	 * the backward boundary scan is capped at one record (4 MiB) and billed.
	 */
	readonly consistency?: 'closed' | 'snapshot'
}

/** @experimental Literal search; empty query browses tool records. */
export interface RunEvidenceSearchOptions {
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
export interface RunEvidenceMatch {
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
export interface RunEvidenceSearchResult {
	readonly scope: RunEvidenceScope
	readonly matches: readonly RunEvidenceMatch[]
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
export interface RunEvidenceReadOptions {
	readonly address: string
	readonly byteOffset?: number
	/** Optional per-call ceiling, 1–8 MiB, capped by the source's own ceiling. */
	readonly maxReadBytes?: number
}

/** @experimental Full means retained text, not binary blocks or proof an action succeeded. */
export interface RunEvidenceReadResult {
	readonly scope: RunEvidenceScope
	readonly seq: number
	/** Same stored-event wall-clock semantics as RunEvidenceMatch.recordedAt. */
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

/** @experimental Retrieval only: never re-executes a tool or resumes a run. */
export interface RunEvidenceSource {
	readonly scope: RunEvidenceScope
	search(options?: RunEvidenceSearchOptions, signal?: AbortSignal): Promise<RunEvidenceSearchResult>
	read(options: RunEvidenceReadOptions, signal?: AbortSignal): Promise<RunEvidenceReadResult>
}

/** @experimental Textual event parts, including assistant output and shed conversation messages. */
export interface RunTextEvidenceSearchOptions extends RunEvidenceSearchOptions {
	/** Omit explicitly marked derived summaries. Default false; bound into cursors. Exact reads remain available. */
	readonly excludeDerivedSummaries?: boolean
	readonly seq?: number
	readonly part?: number
	readonly limit?: number
}

/** @experimental Event identity is durable; byteOffset starts a bounded excerpt in the retained text. */
export interface RunTextEvidenceMatch extends Omit<RunEvidenceMatch, 'toolName' | 'isError'> {
	readonly source: string
	readonly part: number
	readonly toolName?: string
	readonly isError?: boolean
	/** UTF-16 position, when the authenticated source includes a character index. */
	readonly characterOffset?: number
}

/** @experimental Search includes messages and tool text, never binary or private reasoning blocks. */
export interface RunTextEvidenceSearchResult extends Omit<RunEvidenceSearchResult, 'matches'> {
	readonly matches: readonly RunTextEvidenceMatch[]
	/** Derived-summary part visits deliberately skipped, not unique facts or matched passages. */
	readonly excludedSummaries?: number
}

/** @experimental Character counts are UTF-16 units; absent counts must not be inferred from bytes. */
export interface RunTextEvidenceReadResult
	extends Omit<RunEvidenceReadResult, 'toolName' | 'isError'> {
	readonly source: string
	readonly part: number
	readonly toolName?: string
	readonly isError?: boolean
	readonly characterOffset?: number
	readonly totalChars?: number
}

/** @experimental Scope-bound, bounded text retrieval across an invocation's event stream. */
export interface RunTextEvidenceSource {
	readonly scope: RunEvidenceScope
	search(
		options?: RunTextEvidenceSearchOptions,
		signal?: AbortSignal,
	): Promise<RunTextEvidenceSearchResult>
	read(options: RunEvidenceReadOptions, signal?: AbortSignal): Promise<RunTextEvidenceReadResult>
}
