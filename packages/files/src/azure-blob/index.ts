// Azure Blob Storage BlobStore adapter (Phase 2: bytes round-trip).
import { createHash, randomUUID } from 'node:crypto'

import { BlobServiceClient, type ContainerClient, RestError } from '@azure/storage-blob'

import type { BlobPutInput, BlobRecord, BlobStore, StorageRef } from '../index.js'
import { isSafeRelativePath } from '../index.js'

const DEFAULT_CONTAINER = 'vandal-files'
const PROVIDER = 'azure-blob' as const

export interface AzureBlobStoreOptions {
	/** Azure Storage connection string. Required. */
	readonly connectionString: string
	/** Container name; created on first use if missing. Default: 'vandal-files'. */
	readonly container?: string
	/** Optional key prefix (e.g. 'tenant-id/'); prepended to every key. */
	readonly keyPrefix?: string
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

function isNotFound(err: unknown): boolean {
	if (err instanceof RestError) {
		return err.statusCode === 404
	}
	if (err && typeof err === 'object' && 'statusCode' in err) {
		return (err as { statusCode?: number }).statusCode === 404
	}
	return false
}

/**
 * Azure Blob Storage `BlobStore` implementation. Stores each blob as a
 * block blob inside a single container, returning
 * `provider: 'azure-blob'` `StorageRef`s. Caller-supplied keys pass
 * through `isSafeRelativePath` to block path traversal. The container
 * is created lazily on first `put`; subsequent calls reuse the cached
 * promise so the existence check is paid exactly once per process.
 *
 * The `etag` returned on `put` is a content-addressable sha256 hex
 * digest of the payload — not Azure's own ETag, which uses an opaque
 * format. This keeps the etag stable across providers.
 */
export class AzureBlobStore implements BlobStore {
	readonly #blobService: BlobServiceClient
	readonly #container: ContainerClient
	readonly #containerName: string
	readonly #keyPrefix: string
	#ensurePromise?: Promise<void>

	constructor(options: AzureBlobStoreOptions) {
		this.#blobService = BlobServiceClient.fromConnectionString(options.connectionString)
		this.#containerName = options.container ?? DEFAULT_CONTAINER
		this.#container = this.#blobService.getContainerClient(this.#containerName)
		this.#keyPrefix = options.keyPrefix ?? ''
	}

	get containerName(): string {
		return this.#containerName
	}

	async ensureContainer(): Promise<void> {
		if (!this.#ensurePromise) {
			this.#ensurePromise = this.#container.createIfNotExists().then(() => undefined)
		}
		return this.#ensurePromise
	}

	async put(input: BlobPutInput): Promise<StorageRef> {
		if (input.key !== undefined && !isSafeRelativePath(input.key)) {
			throw new Error('unsafe key path')
		}
		const baseKey = input.key ?? randomUUID()
		const fullKey = `${this.#keyPrefix}${baseKey}`
		const bytes = new Uint8Array(input.bytes)
		await this.ensureContainer()
		const blob = this.#container.getBlockBlobClient(fullKey)
		const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		await blob.uploadData(buffer)
		return {
			provider: PROVIDER,
			key: fullKey,
			sizeBytes: bytes.byteLength,
			etag: sha256Hex(bytes),
			downloadable: true,
		}
	}

	async get(storage: StorageRef): Promise<BlobRecord | null> {
		const blob = this.#container.getBlockBlobClient(storage.key)
		try {
			const buf = await blob.downloadToBuffer()
			const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
			return {
				storage: {
					provider: PROVIDER,
					key: storage.key,
					sizeBytes: bytes.byteLength,
					etag: sha256Hex(bytes),
					downloadable: true,
				},
				bytes,
			}
		} catch (err) {
			if (isNotFound(err)) return null
			throw err
		}
	}

	async delete(storage: StorageRef): Promise<void> {
		const blob = this.#container.getBlockBlobClient(storage.key)
		await blob.deleteIfExists()
	}

	async head(storage: StorageRef): Promise<StorageRef | null> {
		const blob = this.#container.getBlockBlobClient(storage.key)
		try {
			const props = await blob.getProperties()
			return {
				provider: PROVIDER,
				key: storage.key,
				sizeBytes: props.contentLength,
				downloadable: true,
			}
		} catch (err) {
			if (isNotFound(err)) return null
			throw err
		}
	}
}
