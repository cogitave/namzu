import { renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskMemoryStore } from '../disk.js'
import { MEMORY_LOCK_RECORD_GRACE_MS, acquireMemoryOperationLock } from '../operation-lock.js'

const roots: string[] = []
afterEach(async () => removeTempDirs(roots.splice(0)))

async function fixture() {
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-memory-operation-lock-'))
	roots.push(baseDir)
	const store = new DiskMemoryStore({ baseDir, lockTimeoutMs: 25 })
	await store.list()
	return { baseDir, store, path: join(baseDir, 'memory', 'operation.lock') }
}

describe('memory operation lock refuses unsafe or unresolved owners', () => {
	it("retains a changed lock owner instead of releasing somebody else's lock", async () => {
		const { path } = await fixture()
		const release = await acquireMemoryOperationLock(path, 25)
		const original = JSON.parse(await readFile(path, 'utf8'))
		expect(original.pid).toBe(process.pid)
		expect(typeof original.acquiredAt).toBe('number')
		const replacement = JSON.stringify({ ...original, token: 'different-owner' })
		await writeFile(path, replacement)
		await expect(release()).rejects.toThrow('lock owner changed')
		expect(await readFile(path, 'utf8')).toBe(replacement)
	})

	it("bounds its wait and preserves a live owner's lock", async () => {
		const { store, path } = await fixture()
		const owner = JSON.stringify({ pid: process.pid, acquiredAt: 1, token: 'live-fixture' })
		await writeFile(path, owner)
		await expect(store.list()).rejects.toThrow(
			`Another Namzu process (pid ${process.pid}) is using the stored memory. Close it, or wait for it to finish.`,
		)
		await expect(
			store.create({ title: 'must not write', summary: '', content: '' }),
		).rejects.toMatchObject({ code: 'storage_error' })
		expect(await readFile(path, 'utf8')).toBe(owner)
	})

	it.skipIf(process.platform === 'win32')('does not follow a symlink used as a lock', async () => {
		const { store, baseDir, path } = await fixture()
		const target = join(baseDir, 'unrelated')
		await writeFile(target, 'untouched')
		await symlink(target, path)
		await expect(store.list()).rejects.toThrow('not a regular file')
		expect(await readFile(target, 'utf8')).toBe('untouched')
	})

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
		'rejects an invalid wait bound %s at construction',
		(lockTimeoutMs) => {
			expect(() => new DiskMemoryStore({ baseDir: '/unused', lockTimeoutMs })).toThrow(
				'positive safe integer',
			)
		},
	)
})

describe('memory operation lock recovers when its owner is provably gone', () => {
	const HOST = 'this-host'
	const NOW = 1_800_000_000_000
	const dead = () => false
	const opts = (extra: Record<string, unknown> = {}) => ({
		now: () => NOW,
		hostname: HOST,
		isPidAlive: dead,
		...extra,
	})

	async function lockFile(content: string, ageMs = 0) {
		const { path } = await fixture()
		await writeFile(path, content)
		const at = new Date(NOW - ageMs)
		await utimes(path, at, at)
		return path
	}
	const record = (extra: Record<string, unknown> = {}) =>
		JSON.stringify({ pid: 4242, token: 't', acquiredAt: 1, ...extra })
	const old = MEMORY_LOCK_RECORD_GRACE_MS + 1000

	it('breaks a lock whose owner pid is dead and acquires it', async () => {
		const path = await lockFile(record())
		const infos: unknown[][] = []
		const logger = { info: (...a: unknown[]) => infos.push(a) } as never
		const release = await acquireMemoryOperationLock(path, 50, opts({ logger }))
		expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(process.pid)
		expect(infos.length).toBe(1)
		await release()
		await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(stat(`${path}.break`)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('times out on a live owner with the plain message and keeps the lock', async () => {
		const path = await lockFile(record({ hostname: HOST }))
		await expect(
			acquireMemoryOperationLock(path, 25, opts({ isPidAlive: () => true })),
		).rejects.toMatchObject({
			code: 'storage_error',
			message:
				'Another Namzu process (pid 4242) is using the stored memory. Close it, or wait for it to finish.',
			details: { lockPath: path, timeoutMs: 25 },
			retryable: false,
		})
		expect(await readFile(path, 'utf8')).toBe(record({ hostname: HOST }))
	})

	it('respects a young empty lock and breaks an old empty or unparsable one', async () => {
		const young = await lockFile('', 1000)
		await expect(acquireMemoryOperationLock(young, 25, opts())).rejects.toMatchObject({
			code: 'storage_error',
		})
		expect(await readFile(young, 'utf8')).toBe('')
		for (const content of ['', '{"pid":', 'not json', '{"pid":"x"}']) {
			const path = await lockFile(content, old)
			const release = await acquireMemoryOperationLock(path, 50, opts())
			await release()
		}
	})

	it('never breaks a record written by another host', async () => {
		const path = await lockFile(record({ hostname: 'elsewhere' }), old * 100)
		await expect(acquireMemoryOperationLock(path, 25, opts())).rejects.toMatchObject({
			code: 'storage_error',
		})
		expect(await readFile(path, 'utf8')).toBe(record({ hostname: 'elsewhere' }))
	})

	it('ends with exactly one holder when two acquirers meet one stale lock', async () => {
		const path = await lockFile(record())
		let holders = 0
		let maxHolders = 0
		const run = async () => {
			const release = await acquireMemoryOperationLock(
				path,
				2000,
				opts({ isPidAlive: (pid: number) => pid === process.pid }),
			)
			holders++
			maxHolders = Math.max(maxHolders, holders)
			await delayTick()
			holders--
			await release()
		}
		await Promise.all([run(), run(), run()])
		expect(maxHolders).toBe(1)
		await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(stat(`${path}.break`)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('does not unlink a lock that was replaced after inspection', async () => {
		const path = await lockFile(record())
		const replacement = record({ pid: 777, token: 'new' })
		let calls = 0
		// First call: the initial verdict. Second call: the re-inspection under the
		// break file; swap in a new inode there, after which the unlink must not happen.
		const isPidAlive = () => {
			calls++
			if (calls === 2) {
				writeFileSync(`${path}.swap`, replacement)
				renameSync(`${path}.swap`, path)
			}
			return calls <= 2
		}
		await expect(acquireMemoryOperationLock(path, 25, opts({ isPidAlive }))).rejects.toMatchObject({
			code: 'storage_error',
		})
		expect(await readFile(path, 'utf8')).toBe(replacement)
	})

	it("breaks a dead breaker's leftover break file once", async () => {
		const path = await lockFile(record())
		await writeFile(`${path}.break`, record({ pid: 5555 }))
		const release = await acquireMemoryOperationLock(path, 50, opts())
		await release()
		await expect(stat(`${path}.break`)).rejects.toMatchObject({ code: 'ENOENT' })
	})
})

const delayTick = () => new Promise<void>((resolve) => setImmediate(resolve))
