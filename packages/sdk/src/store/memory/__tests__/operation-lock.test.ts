import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskMemoryStore } from '../disk.js'
import { acquireMemoryOperationLock } from '../operation-lock.js'

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

	it('bounds its wait and preserves a stale lock for explicit recovery', async () => {
		const { store, path } = await fixture()
		const owner = JSON.stringify({ pid: 999_999_999, acquiredAt: 1, token: 'stale-fixture' })
		await writeFile(path, owner)
		await expect(store.list()).rejects.toThrow('acquisition timed out after 25 ms')
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
