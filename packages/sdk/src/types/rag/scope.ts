import type { TenantId } from '../ids/index.js'

export interface TenantScope {
	tenantId: TenantId
	namespace?: string
}

/** Cancellation shared by one public RAG operation and its downstream I/O. */
export interface RAGOperationOptions {
	readonly signal?: AbortSignal
}

export interface DocumentMetadata {
	source?: string
	title?: string
	mimeType?: string
	language?: string
	tags?: string[]
	[key: string]: unknown
}
