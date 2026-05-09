import { describe, expect, it } from 'vitest'

import { runBlobStoreConformance } from '../__tests__/conformance.js'
import { InMemoryBlobStore } from './index.js'

runBlobStoreConformance('InMemoryBlobStore', {
	async create() {
		return new InMemoryBlobStore()
	},
	async cleanup() {
		/* nothing */
	},
})

describe('InMemoryBlobStore — adapter specifics', () => {
	it('returns provider="memory" on every StorageRef', async () => {
		const store = new InMemoryBlobStore()
		const ref = await store.put({ bytes: new TextEncoder().encode('x') })
		expect(ref.provider).toBe('memory')
	})

	it('two stores do not share state', async () => {
		const a = new InMemoryBlobStore()
		const b = new InMemoryBlobStore()
		const ref = await a.put({ bytes: new TextEncoder().encode('x') })
		expect(await b.get(ref)).toBeNull()
	})

	it('etag is stable for the same payload', async () => {
		const store = new InMemoryBlobStore()
		const payload = new TextEncoder().encode('repeatable')
		const ref1 = await store.put({ bytes: payload })
		const ref2 = await store.put({ bytes: payload })
		expect(ref1.etag).toBe(ref2.etag)
	})

	it('mutating the input bytes after put does not corrupt stored data', async () => {
		const store = new InMemoryBlobStore()
		const payload = new Uint8Array([1, 2, 3])
		const ref = await store.put({ bytes: payload })
		payload[0] = 99
		const got = await store.get(ref)
		expect(got?.bytes[0]).toBe(1)
	})
})
