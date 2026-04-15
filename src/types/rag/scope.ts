import type { TenantId } from '../ids/index.js'

export interface TenantScope {
	tenantId: TenantId
	namespace?: string
}

export interface DocumentMetadata {
	source?: string
	title?: string
	mimeType?: string
	language?: string
	tags?: string[]
	[key: string]: unknown
}
