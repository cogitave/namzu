import { mkdtemp, readFile, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { SessionLeaseDocumentSchema } from '../../../types/session/records.js'
import { DiskSessionLeaseStore, InMemorySessionLeaseStore, readSessionLease } from '../lease.js'

const made: string[] = []
afterAll(async () => {
	await removeTempDirs(made.splice(0))
})

async function sessionDir(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-lease-')))
	made.push(root)
	return join(root, 'session')
}

describe('the disk lease', () => {
	it('mints a higher fence for every new holding and never rewinds', async () => {
		const dir = await sessionDir()
		const a = await new DiskSessionLeaseStore(dir).claim({ holder: 'a', ttlMs: 100, now: 0 })
		expect(a).toEqual({ holder: 'a', fence: 1, expiresAt: 100 })
		const b = new DiskSessionLeaseStore(dir)
		expect(await b.claim({ holder: 'b', ttlMs: 100, now: 50 })).toBe(null)
		const taken = await b.claim({ holder: 'b', ttlMs: 100, now: 200 })
		expect(taken?.fence).toBe(2)
		await b.release(taken as NonNullable<typeof taken>)
		// The release is a tombstone at the next fence, so fence 2 is stale at once.
		expect(await b.fence()).toBe(3)
		expect(await b.current()).toEqual({ holder: '', fence: 3, expiresAt: 0 })
		const c = await new DiskSessionLeaseStore(dir).claim({ holder: 'c', ttlMs: 100, now: 201 })
		expect(c?.fence).toBe(4)
	})

	it('renews on the same instance without changing the fence', async () => {
		const store = new DiskSessionLeaseStore(await sessionDir())
		const first = await store.claim({ holder: 'a', ttlMs: 100, now: 0 })
		const renewed = await store.claim({ holder: 'a', ttlMs: 100, now: 50 })
		expect(renewed).toEqual({ holder: 'a', fence: first?.fence, expiresAt: 150 })
		expect((await store.current())?.expiresAt).toBe(150)
	})

	it('gives a same-named holder in another instance a new fence, not the old one', async () => {
		const dir = await sessionDir()
		await new DiskSessionLeaseStore(dir).claim({ holder: 'cli', ttlMs: 1000, now: 0 })
		// A restarted process with the same holder name does not inherit the dead one's fence.
		const restarted = await new DiskSessionLeaseStore(dir).claim({
			holder: 'cli',
			ttlMs: 1000,
			now: 10,
		})
		expect(restarted?.fence).toBe(2)
	})

	it('releases nothing for a stale fence', async () => {
		const dir = await sessionDir()
		const a = await new DiskSessionLeaseStore(dir).claim({ holder: 'a', ttlMs: 10, now: 0 })
		const b = await new DiskSessionLeaseStore(dir).claim({ holder: 'b', ttlMs: 1000, now: 20 })
		await new DiskSessionLeaseStore(dir).release(a as NonNullable<typeof a>)
		expect(await readSessionLease(dir)).toEqual(b)
	})

	it('gives the session to exactly one of many simultaneous takers', async () => {
		const dir = await sessionDir()
		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				new DiskSessionLeaseStore(dir).claim({ holder: `w${i}`, ttlMs: 60_000, now: 1 }),
			),
		)
		const winners = results.filter((r) => r !== null)
		expect(winners).toHaveLength(1)
		expect(winners[0]?.fence).toBe(1)
	})

	it('publishes lease.json as a readable view of the current holding', async () => {
		const dir = await sessionDir()
		await new DiskSessionLeaseStore(dir).claim({ holder: 'a', ttlMs: 1000, now: 0 })
		const view = SessionLeaseDocumentSchema.parse(
			JSON.parse(await readFile(join(dir, 'lease.json'), 'utf8')),
		)
		expect(view).toEqual({
			v: 1,
			kind: 'lease',
			holder: 'a',
			fence: 1,
			expiresAt: new Date(1000).toISOString(),
		})
		expect((await readdir(dir)).sort()).toEqual(['lease.1.json', 'lease.json'])
	})

	it('keeps only a window of holdings below the current fence', async () => {
		const dir = await sessionDir()
		for (let i = 0; i < 20; i++) {
			await new DiskSessionLeaseStore(dir).claim({ holder: `w${i}`, ttlMs: 1, now: i * 10 })
		}
		const fences = (await readdir(dir))
			.map((name) => /^lease\.(\d+)\.json$/.exec(name)?.[1])
			.filter((f) => f !== undefined)
			.map(Number)
		expect(Math.max(...fences)).toBe(20)
		expect(Math.min(...fences)).toBe(12)
	})
})

describe('the in-memory lease', () => {
	it('follows the same fence rules in process', async () => {
		const store = new InMemorySessionLeaseStore()
		const a = await store.claim({ holder: 'a', ttlMs: 100, now: 0 })
		expect(await store.claim({ holder: 'b', ttlMs: 100, now: 50 })).toBe(null)
		expect((await store.claim({ holder: 'a', ttlMs: 100, now: 60 }))?.fence).toBe(a?.fence)
		const b = await store.claim({ holder: 'b', ttlMs: 100, now: 500 })
		expect(b?.fence).toBe(2)
		await store.release(a as NonNullable<typeof a>)
		expect(await store.current()).toEqual(b)
		await store.release(b as NonNullable<typeof b>)
		expect(await store.fence()).toBe(3)
	})
})
