import { describe, expect, it } from 'vitest'

import { runBlobStoreConformance } from '../__tests__/conformance.js'
import { AzureBlobStore } from './index.js'

const CONN =
	process.env.AZURE_STORAGE_CONNECTION_STRING ??
	'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;'

let testCounter = 0
const uniqueContainer = () => `test-${Date.now()}-${++testCounter}`

async function dropContainer(name: string): Promise<void> {
	const { BlobServiceClient } = await import('@azure/storage-blob')
	const svc = BlobServiceClient.fromConnectionString(CONN)
	await svc.deleteContainer(name).catch(() => undefined)
}

runBlobStoreConformance('AzureBlobStore', {
	async create() {
		return new AzureBlobStore({
			connectionString: CONN,
			container: uniqueContainer(),
		})
	},
	async cleanup(store) {
		const container = (store as unknown as { containerName: string }).containerName
		await dropContainer(container)
	},
})

describe('AzureBlobStore — adapter specifics', () => {
	it('returns provider="azure-blob" on every StorageRef', async () => {
		const store = new AzureBlobStore({ connectionString: CONN, container: uniqueContainer() })
		try {
			const ref = await store.put({ bytes: new TextEncoder().encode('x') })
			expect(ref.provider).toBe('azure-blob')
		} finally {
			await dropContainer(store.containerName)
		}
	})

	it('rejects path-traversal keys', async () => {
		const store = new AzureBlobStore({ connectionString: CONN, container: uniqueContainer() })
		try {
			await expect(
				store.put({ key: '../escape', bytes: new TextEncoder().encode('x') }),
			).rejects.toThrow()
			await expect(
				store.put({ key: '/abs/path', bytes: new TextEncoder().encode('x') }),
			).rejects.toThrow()
		} finally {
			await dropContainer(store.containerName)
		}
	})

	it('honours keyPrefix on put', async () => {
		const store = new AzureBlobStore({
			connectionString: CONN,
			container: uniqueContainer(),
			keyPrefix: 'org/abc/',
		})
		try {
			const ref = await store.put({ key: 'file.txt', bytes: new TextEncoder().encode('x') })
			expect(ref.key).toBe('org/abc/file.txt')
		} finally {
			await dropContainer(store.containerName)
		}
	})

	it('etag is stable for the same payload', async () => {
		const store = new AzureBlobStore({ connectionString: CONN, container: uniqueContainer() })
		try {
			const payload = new TextEncoder().encode('repeatable')
			const ref1 = await store.put({ bytes: payload })
			const ref2 = await store.put({ bytes: payload })
			expect(ref1.etag).toBe(ref2.etag)
		} finally {
			await dropContainer(store.containerName)
		}
	})
})
