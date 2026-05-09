export type NamzuFileId = string

export type NamzuFileScopeType =
	| 'tenant'
	| 'project'
	| 'thread'
	| 'session'
	| 'run'
	| 'message'
	| 'agent'
	| 'task'
	| 'workspace'
	| 'draft'

export type NamzuFileRole =
	| 'context'
	| 'input'
	| 'output'
	| 'artifact'
	| 'doc'
	| 'memory'
	| 'attachment'

export type NamzuFileSource =
	| 'user_upload'
	| 'text_document'
	| 'runtime_output'
	| 'generated_artifact'
	| 'external_provider'

export type NamzuStorageProvider =
	| 'memory'
	| 'local-fs'
	| 'postgres-bytea'
	| 's3'
	| 'azure-blob'
	| 'anthropic-files'
	| (string & {})

export interface NamzuStorageRef {
	readonly provider: NamzuStorageProvider
	readonly key: string
	readonly etag?: string
	readonly sizeBytes?: number
	readonly downloadable?: boolean
}

export interface NamzuFileScope {
	readonly type: NamzuFileScopeType
	readonly id: string
}

export interface NamzuFileRecord {
	readonly id: NamzuFileId
	readonly ownerId: string
	readonly filename: string
	readonly mimeType: string
	readonly sizeBytes: number
	readonly sha256?: string
	readonly source: NamzuFileSource
	readonly storage: NamzuStorageRef
	readonly createdAt: Date
	readonly updatedAt: Date
}

export interface NamzuFileLink {
	readonly fileId: NamzuFileId
	readonly scope: NamzuFileScope
	readonly role: NamzuFileRole
	readonly createdAt: Date
}

export interface NamzuFileTextDocument {
	readonly fileId: NamzuFileId
	readonly content: string
	readonly estimatedTokenCount?: number
	readonly extractionStatus: 'pending' | 'ready' | 'failed'
	readonly updatedAt: Date
}

export interface NamzuFileCreateInput {
	readonly id?: NamzuFileId
	readonly ownerId: string
	readonly filename: string
	readonly mimeType: string
	readonly sizeBytes: number
	readonly sha256?: string
	readonly source: NamzuFileSource
	readonly storage: NamzuStorageRef
	readonly links?: readonly Omit<NamzuFileLink, 'fileId' | 'createdAt'>[]
	readonly textDocument?: Omit<NamzuFileTextDocument, 'fileId' | 'updatedAt'>
}

export interface NamzuFileListInput {
	readonly scope: NamzuFileScope
	readonly roles?: readonly NamzuFileRole[]
	readonly ownerId?: string
}

export interface NamzuBlobPutInput {
	readonly key?: string
	readonly bytes: Uint8Array
	readonly mimeType?: string
	readonly filename?: string
}

export interface NamzuBlob {
	readonly storage: NamzuStorageRef
	readonly bytes: Uint8Array
}

export interface NamzuBlobStore {
	put(input: NamzuBlobPutInput): Promise<NamzuStorageRef>
	get(storage: NamzuStorageRef): Promise<NamzuBlob | null>
	delete(storage: NamzuStorageRef): Promise<void>
	head(storage: NamzuStorageRef): Promise<NamzuStorageRef | null>
}

export interface NamzuFileRegistry {
	create(input: NamzuFileCreateInput): Promise<NamzuFileRecord>
	link(input: Omit<NamzuFileLink, 'createdAt'>): Promise<NamzuFileLink>
	unlink(input: Omit<NamzuFileLink, 'createdAt'>): Promise<void>
	list(input: NamzuFileListInput): Promise<NamzuFileRecord[]>
	get(fileId: NamzuFileId): Promise<NamzuFileRecord | null>
	getTextDocument(fileId: NamzuFileId): Promise<NamzuFileTextDocument | null>
}

export interface NamzuFilesChangedEvent {
	readonly scope: NamzuFileScope
	readonly roles?: readonly NamzuFileRole[]
	readonly revision?: number
}

export interface NamzuFileEventSink {
	filesChanged(event: NamzuFilesChangedEvent): Promise<void>
}

export function isSafeRelativePath(path: string): boolean {
	if (!path || path.startsWith('/') || path.includes('\\')) return false
	const parts = path.split('/')
	return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}
