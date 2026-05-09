// Local filesystem BlobStore adapter (dev loop).
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { BlobPutInput, BlobRecord, BlobStore, StorageRef } from '../index.js'
import { isSafeRelativePath } from '../index.js'

export interface LocalFsBlobStoreOptions {
	readonly root: string
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && 'code' in err
}

/**
 * Local filesystem `BlobStore` implementation. Stores each blob as a
 * regular file under `<root>/<key>`, returning `provider: 'local-fs'`
 * `StorageRef`s. Caller-supplied keys are validated through
 * `isSafeRelativePath` to block path traversal (`..`, absolute paths,
 * backslashes). The adapter is intended for the dev loop — there is
 * no fsync, locking, or concurrency control.
 */
export class LocalFsBlobStore implements BlobStore {
	readonly #root: string

	constructor(options: LocalFsBlobStoreOptions) {
		this.#root = options.root
	}

	async put(input: BlobPutInput): Promise<StorageRef> {
		const key = input.key ?? randomUUID()
		if (input.key !== undefined && !isSafeRelativePath(input.key)) {
			throw new Error('unsafe key path')
		}
		const bytes = new Uint8Array(input.bytes)
		const target = join(this.#root, key)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, bytes)
		return {
			provider: 'local-fs',
			key,
			sizeBytes: bytes.byteLength,
			etag: sha256Hex(bytes),
			downloadable: true,
		}
	}

	async get(storage: StorageRef): Promise<BlobRecord | null> {
		const target = join(this.#root, storage.key)
		try {
			const buf = await readFile(target)
			const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
			return {
				storage: {
					provider: 'local-fs',
					key: storage.key,
					sizeBytes: bytes.byteLength,
					etag: sha256Hex(bytes),
					downloadable: true,
				},
				bytes,
			}
		} catch (err) {
			if (isErrnoException(err) && err.code === 'ENOENT') return null
			throw err
		}
	}

	async delete(storage: StorageRef): Promise<void> {
		const target = join(this.#root, storage.key)
		try {
			await rm(target)
		} catch (err) {
			if (isErrnoException(err) && err.code === 'ENOENT') return
			throw err
		}
	}

	async head(storage: StorageRef): Promise<StorageRef | null> {
		const target = join(this.#root, storage.key)
		try {
			const info = await stat(target)
			return {
				provider: 'local-fs',
				key: storage.key,
				sizeBytes: info.size,
				downloadable: true,
			}
		} catch (err) {
			if (isErrnoException(err) && err.code === 'ENOENT') return null
			throw err
		}
	}
}
