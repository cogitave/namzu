export interface TenantScope {
	tenantId: string
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
