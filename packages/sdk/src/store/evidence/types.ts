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
}

/** @experimental Literal search; empty query browses tool records. */
export interface RunEvidenceSearchOptions {
	readonly query?: string
	/**
	 * Find passages matching any of 1–16 nonblank literal terms (up to 256 UTF-16
	 * units each) in the same bounded scan. Mutually exclusive with query, even
	 * an empty query. Exact duplicate terms and their order do not matter.
	 * This is candidate discovery, not relevance ranking or natural-language parsing.
	 */
	readonly terms?: readonly string[]
	/** Defaults to true. False uses Unicode case-insensitive literal matching. */
	readonly caseSensitive?: boolean
	readonly cursor?: string
}

/** @experimental Opaque addresses remain usable after restart while the source is unchanged. */
export interface RunEvidenceMatch {
	readonly address: string
	readonly seq: number
	readonly toolName: string
	readonly isError: boolean
	readonly retained: 'full' | 'preview'
	readonly excerpt: string
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
}

/** @experimental Byte offsets refer to UTF-8 retained text, not the current workspace file. */
export interface RunEvidenceReadOptions {
	readonly address: string
	readonly byteOffset?: number
}

/** @experimental Full means retained text, not binary blocks or proof an action succeeded. */
export interface RunEvidenceReadResult {
	readonly scope: RunEvidenceScope
	readonly seq: number
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
