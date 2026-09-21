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

	it('renews the holding it is shown without changing the fence', async () => {
		const store = new DiskSessionLeaseStore(await sessionDir())
		const first = await store.claim({ holder: 'a', ttlMs: 100, now: 0 })
		if (first === null) throw new Error('claim failed')
		const renewed = await store.claim({ holder: 'a', ttlMs: 100, now: 50 }, { renew: first })
		expect(renewed).toEqual({ holder: 'a', fence: first.fence, expiresAt: 150 })
		expect((await store.current())?.expiresAt).toBe(150)
	})

	it('renews late on the same fence when nobody took the session in between', async () => {
		const store = new DiskSessionLeaseStore(await sessionDir())
		const first = await store.claim({ holder: 'a', ttlMs: 100, now: 0 })
		if (first === null) throw new Error('claim failed')
		const late = await store.claim({ holder: 'a', ttlMs: 100, now: 500 }, { renew: first })
		expect(late).toEqual({ holder: 'a', fence: first.fence, expiresAt: 600 })
	})

	it('does not renew a holding somebody else took over', async () => {
		const dir = await sessionDir()
		const first = await new DiskSessionLeaseStore(dir).claim({ holder: 'a', ttlMs: 100, now: 0 })
		if (first === null) throw new Error('claim failed')
		const taken = await new DiskSessionLeaseStore(dir).claim({ holder: 'b', ttlMs: 100, now: 500 })
		expect(taken?.fence).toBe(2)
		const late = await new DiskSessionLeaseStore(dir).claim(
			{ holder: 'a', ttlMs: 100, now: 501 },
			{ renew: first },
		)
		expect(late).toBe(null)
	})

	it('refuses a same-named holder that does not present the live lease, and mints after expiry', async () => {
		const dir = await sessionDir()
		await new DiskSessionLeaseStore(dir).claim({ holder: 'cli', ttlMs: 1000, now: 0 })
		// The name is evidence, not authority: a second instance with it waits like anyone else.
		const twin = new DiskSessionLeaseStore(dir)
		expect(await twin.claim({ holder: 'cli', ttlMs: 1000, now: 10 })).toBe(null)
		// A restarted process with the same name does not inherit the dead one's fence.
		const restarted = await twin.claim({ holder: 'cli', ttlMs: 1000, now: 2000 })
		expect(restarted?.fence).toBe(2)
	})

	it('mints a fence above the floor it is given, even with no lease files', async () => {
		const store = new DiskSessionLeaseStore(await sessionDir())
		const lease = await store.claim({ holder: 'a', ttlMs: 100, now: 0 }, { above: 7 })
		expect(lease?.fence).toBe(8)
		if (lease === null) throw new Error('claim failed')
		// A holding below the floor is not renewed; its holder gets a fresh fence.
		expect(
			(await store.claim({ holder: 'a', ttlMs: 100, now: 10 }, { renew: lease, above: 9 }))?.fence,
		).toBe(10)
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
		if (a === null) throw new Error('claim failed')
		expect(await store.claim({ holder: 'b', ttlMs: 100, now: 50 })).toBe(null)
		// A name alone does not renew; presenting the holding does.
		expect(await store.claim({ holder: 'a', ttlMs: 100, now: 55 })).toBe(null)
		expect((await store.claim({ holder: 'a', ttlMs: 100, now: 60 }, { renew: a }))?.fence).toBe(
			a.fence,
		)
		const b = await store.claim({ holder: 'b', ttlMs: 100, now: 500 })
		expect(b?.fence).toBe(2)
		await store.release(a as NonNullable<typeof a>)
		expect(await store.current()).toEqual(b)
		await store.release(b as NonNullable<typeof b>)
		expect(await store.fence()).toBe(3)
		expect((await store.claim({ holder: 'c', ttlMs: 100, now: 600 }, { above: 9 }))?.fence).toBe(10)
	})
})
