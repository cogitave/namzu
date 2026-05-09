// In-memory BlobStore adapter (test fixtures / CI).
import { createHash, randomUUID } from 'node:crypto'

import type { BlobPutInput, BlobRecord, BlobStore, StorageRef } from '../index.js'

/**
 * Slugify a filename for use as part of a generated key. Keeps the
 * key human-readable in test output without leaking unsafe characters.
 */
function slugifyFilename(filename: string): string {
	const trimmed = filename.trim().toLowerCase()
	if (!trimmed) return ''
	return trimmed
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

/**
 * In-memory `BlobStore` implementation. Stores bytes in a private
 * `Map`, returning `provider: 'memory'` `StorageRef`s. Defensive copies
 * are taken on both `put` and `get` so callers cannot mutate stored
 * payloads via shared `Uint8Array` references.
 */
export class InMemoryBlobStore implements BlobStore {
	readonly #blobs = new Map<string, Uint8Array>()

	async put(input: BlobPutInput): Promise<StorageRef> {
		const bytes = new Uint8Array(input.bytes)
		const key = input.key ?? this.#generateKey(input.filename)
		this.#blobs.set(key, bytes)
		return {
			provider: 'memory',
			key,
			sizeBytes: bytes.byteLength,
			etag: sha256Hex(bytes),
		}
	}

	async get(storage: StorageRef): Promise<BlobRecord | null> {
		const stored = this.#blobs.get(storage.key)
		if (!stored) return null
		const bytes = new Uint8Array(stored)
		return {
			storage: {
				provider: 'memory',
				key: storage.key,
				sizeBytes: bytes.byteLength,
				etag: sha256Hex(bytes),
			},
			bytes,
		}
	}

	async delete(storage: StorageRef): Promise<void> {
		this.#blobs.delete(storage.key)
	}

	async head(storage: StorageRef): Promise<StorageRef | null> {
		const stored = this.#blobs.get(storage.key)
		if (!stored) return null
		return {
			provider: 'memory',
			key: storage.key,
			sizeBytes: stored.byteLength,
			etag: sha256Hex(stored),
		}
	}

	#generateKey(filename: string | undefined): string {
		const id = randomUUID()
		const slug = filename ? slugifyFilename(filename) : ''
		return slug ? `${id}-${slug}` : id
	}
}
