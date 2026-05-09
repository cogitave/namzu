export type FileId = string

export type FileScopeType =
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

export type FileRole = 'context' | 'input' | 'output' | 'artifact' | 'doc' | 'memory' | 'attachment'

export type FileSource =
	| 'user_upload'
	| 'text_document'
	| 'runtime_output'
	| 'generated_artifact'
	| 'external_provider'

export type StorageProviderId =
	| 'memory'
	| 'local-fs'
	| 'postgres-bytea'
	| 's3'
	| 'azure-blob'
	| 'gcs'
	| 'anthropic-files'
	| (string & {})

export interface StorageRef {
	readonly provider: StorageProviderId
	readonly key: string
	readonly etag?: string
	readonly sizeBytes?: number
	readonly downloadable?: boolean
}

export interface FileScope {
	readonly type: FileScopeType
	readonly id: string
}

export interface FileRecord {
	readonly id: FileId
	readonly ownerId: string
	readonly filename: string
	readonly mimeType: string
	readonly sizeBytes: number
	readonly sha256?: string
	readonly source: FileSource
	readonly storage: StorageRef
	readonly createdAt: Date
	readonly updatedAt: Date
}

export interface FileLink {
	readonly fileId: FileId
	readonly scope: FileScope
	readonly role: FileRole
	readonly createdAt: Date
}

export interface TextDocument {
	readonly fileId: FileId
	readonly content: string
	readonly estimatedTokenCount?: number
	readonly extractionStatus: 'pending' | 'ready' | 'failed'
	readonly updatedAt: Date
}

export interface FileCreateInput {
	readonly id?: FileId
	readonly ownerId: string
	readonly filename: string
	readonly mimeType: string
	readonly sizeBytes: number
	readonly sha256?: string
	readonly source: FileSource
	readonly storage: StorageRef
	readonly links?: readonly Omit<FileLink, 'fileId' | 'createdAt'>[]
	readonly textDocument?: Omit<TextDocument, 'fileId' | 'updatedAt'>
}

export interface FileListInput {
	readonly scope: FileScope
	readonly roles?: readonly FileRole[]
	readonly ownerId?: string
}

export interface BlobPutInput {
	readonly key?: string
	readonly bytes: Uint8Array
	readonly mimeType?: string
	readonly filename?: string
}

export interface BlobRecord {
	readonly storage: StorageRef
	readonly bytes: Uint8Array
}

export interface BlobStore {
	put(input: BlobPutInput): Promise<StorageRef>
	get(storage: StorageRef): Promise<BlobRecord | null>
	delete(storage: StorageRef): Promise<void>
	head(storage: StorageRef): Promise<StorageRef | null>
}

export interface FileRegistry {
	create(input: FileCreateInput): Promise<FileRecord>
	link(input: Omit<FileLink, 'createdAt'>): Promise<FileLink>
	unlink(input: Omit<FileLink, 'createdAt'>): Promise<void>
	list(input: FileListInput): Promise<FileRecord[]>
	get(fileId: FileId): Promise<FileRecord | null>
	getTextDocument(fileId: FileId): Promise<TextDocument | null>
}

export interface FilesChangedEvent {
	readonly scope: FileScope
	readonly roles?: readonly FileRole[]
	readonly revision?: number
}

export interface FileEventSink {
	filesChanged(event: FilesChangedEvent): Promise<void>
}

export function isSafeRelativePath(path: string): boolean {
	if (!path || path.startsWith('/') || path.includes('\\')) return false
	const parts = path.split('/')
	return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}
