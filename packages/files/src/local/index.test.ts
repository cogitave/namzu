import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runBlobStoreConformance } from '../__tests__/conformance.js'
import { LocalFsBlobStore } from './index.js'

runBlobStoreConformance('LocalFsBlobStore', {
	async create() {
		const root = await mkdtemp(join(tmpdir(), 'namzu-files-local-'))
		const store = new LocalFsBlobStore({ root })
		// attach root for cleanup
		;(store as unknown as { __root: string }).__root = root
		return store
	},
	async cleanup(store) {
		const root = (store as unknown as { __root: string }).__root
		await rm(root, { recursive: true, force: true })
	},
})

describe('LocalFsBlobStore — adapter specifics', () => {
	it('returns provider="local-fs" on every StorageRef', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-files-local-'))
		try {
			const store = new LocalFsBlobStore({ root })
			const ref = await store.put({ bytes: new TextEncoder().encode('x') })
			expect(ref.provider).toBe('local-fs')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects path-traversal keys', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-files-local-'))
		try {
			const store = new LocalFsBlobStore({ root })
			await expect(
				store.put({ key: '../escape', bytes: new TextEncoder().encode('x') }),
			).rejects.toThrow()
			await expect(
				store.put({ key: '/abs/path', bytes: new TextEncoder().encode('x') }),
			).rejects.toThrow()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('creates parent directories on put', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-files-local-'))
		try {
			const store = new LocalFsBlobStore({ root })
			const ref = await store.put({
				key: 'a/b/c/file.bin',
				bytes: new TextEncoder().encode('nested'),
			})
			const got = await store.get(ref)
			expect(got?.bytes).toEqual(new TextEncoder().encode('nested'))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('etag is stable for the same payload', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-files-local-'))
		try {
			const store = new LocalFsBlobStore({ root })
			const payload = new TextEncoder().encode('repeatable')
			const ref1 = await store.put({ bytes: payload })
			const ref2 = await store.put({ bytes: payload })
			expect(ref1.etag).toBe(ref2.etag)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
