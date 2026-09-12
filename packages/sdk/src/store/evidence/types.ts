/** @experimental An explicitly authorized, closed invocation. No directory discovery. */
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
}

/** @experimental Case-sensitive literal search; empty query browses tool records. */
export interface RunEvidenceSearchOptions {
	readonly query?: string
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
