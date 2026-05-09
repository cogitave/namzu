import { describe, expect, it } from 'vitest'

import type { BlobStore } from '../index.js'

/**
 * Behavioural contract suite for `BlobStore` adapters. Each adapter
 * package (inmem, local, postgres, s3, ...) imports
 * `runBlobStoreConformance` and supplies a `BlobStoreFactory` that
 * builds and tears down a fresh store per test. The shared suite
 * pins:
 *
 * - put → get round-trip on small and 1 MiB payloads
 * - get / head return null for missing keys
 * - delete removes the blob and is idempotent on missing keys
 * - put honours a caller-supplied `key` when provided
 *
 * Adapter-specific edge cases (signed-URL minting, multipart upload
 * boundaries, etc.) live in the adapter's own test files alongside.
 */

export interface BlobStoreFactory {
	/** Create a fresh BlobStore for the test. */
	create(): Promise<BlobStore>
	/** Tear down test-local state (e.g. remove temp directories). */
	cleanup(store: BlobStore): Promise<void>
}

const encoder = new TextEncoder()

export function runBlobStoreConformance(name: string, factory: BlobStoreFactory): void {
	describe(`${name} conforms to BlobStore`, () => {
		it('round-trips put/get for a small payload', async () => {
			const store = await factory.create()
			try {
				const payload = encoder.encode('hello world')
				const ref = await store.put({ bytes: payload })
				expect(ref.provider).toBeTruthy()
				expect(ref.key).toBeTruthy()
				const got = await store.get(ref)
				expect(got).not.toBeNull()
				expect(got?.bytes).toEqual(payload)
			} finally {
				await factory.cleanup(store)
			}
		})

		it('get returns null for an unknown key', async () => {
			const store = await factory.create()
			try {
				const ref = await store.put({ bytes: encoder.encode('seed') })
				const fake = { ...ref, key: `${ref.key}-missing` }
				expect(await store.get(fake)).toBeNull()
			} finally {
				await factory.cleanup(store)
			}
		})

		it('head returns metadata for a present blob and null for a missing one', async () => {
			const store = await factory.create()
			try {
				const payload = encoder.encode('abc')
				const ref = await store.put({ bytes: payload })
				const meta = await store.head(ref)
				expect(meta).not.toBeNull()
				expect(meta?.key).toBe(ref.key)
				if (meta?.sizeBytes !== undefined) {
					expect(meta.sizeBytes).toBe(payload.byteLength)
				}
				const fake = { ...ref, key: `${ref.key}-missing` }
				expect(await store.head(fake)).toBeNull()
			} finally {
				await factory.cleanup(store)
			}
		})

		it('delete removes the blob (subsequent get returns null)', async () => {
			const store = await factory.create()
			try {
				const ref = await store.put({ bytes: encoder.encode('drop me') })
				await store.delete(ref)
				expect(await store.get(ref)).toBeNull()
			} finally {
				await factory.cleanup(store)
			}
		})

		it('delete on a missing key is idempotent and does not throw', async () => {
			const store = await factory.create()
			try {
				const ref = await store.put({ bytes: encoder.encode('present') })
				const fake = { ...ref, key: `${ref.key}-missing` }
				await store.delete(fake)
				// The present blob is still readable.
				expect(await store.get(ref)).not.toBeNull()
			} finally {
				await factory.cleanup(store)
			}
		})

		it('put accepts a caller-supplied key when provided', async () => {
			const store = await factory.create()
			try {
				const payload = encoder.encode('keyed')
				const ref = await store.put({ key: 'custom/path/here', bytes: payload })
				expect(ref.key).toBe('custom/path/here')
				const got = await store.get(ref)
				expect(got?.bytes).toEqual(payload)
			} finally {
				await factory.cleanup(store)
			}
		})

		it('round-trips a 1 MiB binary payload', async () => {
			const store = await factory.create()
			try {
				const payload = new Uint8Array(1024 * 1024)
				for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
				const ref = await store.put({ bytes: payload })
				const got = await store.get(ref)
				expect(got).not.toBeNull()
				expect(got?.bytes.byteLength).toBe(payload.byteLength)
				expect(got?.bytes[0]).toBe(0)
				expect(got?.bytes[255]).toBe(255)
				expect(got?.bytes[256]).toBe(0)
			} finally {
				await factory.cleanup(store)
			}
		})
	})
}
