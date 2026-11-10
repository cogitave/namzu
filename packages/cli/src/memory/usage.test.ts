import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { MemoryUsage, type UsageFs, nodeUsageFs } from './usage.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function temp() {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-memory-usage-'))
	roots.push(directory)
	return { directory, file: join(directory, 'memory-usage', 'project.json') }
}

function clock(start = 1_000) {
	let now = start
	return {
		now: () => now,
		set: (value: number) => {
			now = value
		},
	}
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('the usage sidecar', () => {
	it('is unknown while the file is missing, and nothing was counted', async () => {
		const { file } = temp()
		const usage = new MemoryUsage({ file, now: clock().now })
		await usage.load()
		expect(usage.state).toBe('unknown')
		expect(usage.get('a')).toBeUndefined()
		expect(existsSync(file)).toBe(false)
	})

	it('holds counts in memory and writes them together on a flush', async () => {
		const { file } = temp()
		const time = clock(1_000)
		const usage = new MemoryUsage({ file, now: time.now })
		await usage.load()
		usage.recalled(['a', 'b'], ['a'])
		time.set(2_000)
		usage.recalled(['a'])
		// Batched: nothing on disk yet, and the counts are already readable.
		expect(existsSync(file)).toBe(false)
		expect(usage.get('a')).toEqual({ recalls: 2, selected: 1, lastRecalledAt: 2_000 })
		expect(usage.dirty).toBe(true)

		await usage.flush()
		expect(usage.dirty).toBe(false)
		expect(usage.state).toBe('known')
		expect(read(file)).toEqual({
			version: 1,
			// The file began counting when it was first written.
			since: 2_000,
			records: {
				a: { recalls: 2, selected: 1, lastRecalledAt: 2_000 },
				b: { recalls: 1, selected: 0, lastRecalledAt: 1_000 },
			},
			setAside: {},
		})
	})

	it('writes a temporary file and renames it, so a failed write leaves the old file whole', async () => {
		const { file } = temp()
		const time = clock(1_000)
		const first = new MemoryUsage({ file, now: time.now })
		await first.load()
		first.recalled(['a'])
		await first.flush()
		const before = readFileSync(file, 'utf8')

		const steps: string[] = []
		const failing: UsageFs = {
			...nodeUsageFs,
			writeFile: async (path, data) => {
				steps.push(`write ${path.endsWith('.tmp') ? 'tmp' : 'file'}`)
				await nodeUsageFs.writeFile(path, data.slice(0, 5))
				throw new Error('disk full')
			},
		}
		const second = new MemoryUsage({ file, now: time.now, fs: failing })
		await second.load()
		second.recalled(['a'])
		await second.flush()
		expect(steps).toEqual(['write tmp'])
		expect(readFileSync(file, 'utf8')).toBe(before)
		expect(readdirSync(join(file, '..')).filter((name) => name.endsWith('.tmp'))).toEqual([])
		// Still pending: the next flush tries again.
		expect(second.dirty).toBe(true)
	})

	it('flushes through a rename, never a write to the sidecar itself', async () => {
		const { file } = temp()
		const calls: string[] = []
		const spy: UsageFs = {
			...nodeUsageFs,
			writeFile: (path, data) => {
				calls.push(`write:${path === file ? 'sidecar' : 'tmp'}`)
				return nodeUsageFs.writeFile(path, data)
			},
			rename: (from, to) => {
				calls.push(`rename:${to === file ? 'sidecar' : 'other'}`)
				return nodeUsageFs.rename(from, to)
			},
		}
		const usage = new MemoryUsage({ file, now: clock().now, fs: spy })
		await usage.load()
		usage.recalled(['a'])
		await usage.flush()
		expect(calls).toEqual(['write:tmp', 'rename:sidecar'])
	})

	it('reads a corrupt sidecar as unknown, never as unused, and keeps the bad file', async () => {
		const { file } = temp()
		const first = new MemoryUsage({ file, now: clock().now })
		await first.load()
		first.recalled(['a'])
		await first.flush()
		writeFileSync(file, '{"version":1,"since":"soon"')

		const usage = new MemoryUsage({ file, now: clock(5_000).now })
		await usage.load()
		expect(usage.state).toBe('unknown')
		expect(usage.get('a')).toBeUndefined()
		expect(existsSync(`${file}.corrupt`)).toBe(true)
		// It starts counting from now once it can write again.
		usage.recalled(['b'])
		await usage.flush()
		expect(usage.state).toBe('known')
		expect(usage.since).toBe(5_000)
	})

	it.each([
		['not an object', '[1]'],
		['a version it does not know', '{"version":2,"since":1,"records":{},"setAside":{}}'],
		[
			'a negative count',
			'{"version":1,"since":1,"records":{"a":{"recalls":-1,"selected":0,"lastRecalledAt":0}},"setAside":{}}',
		],
	])('reads %s as unknown', async (_name, text) => {
		const { file, directory } = temp()
		writeFileSync(join(directory, 'x.json'), text)
		const usage = new MemoryUsage({ file: join(directory, 'x.json'), now: clock().now })
		await usage.load()
		expect(usage.state).toBe('unknown')
		void file
	})

	it('adds this process’s counts to what another terminal wrote meanwhile', async () => {
		const { file } = temp()
		const time = clock(1_000)
		const a = new MemoryUsage({ file, now: time.now })
		const b = new MemoryUsage({ file, now: time.now })
		await a.load()
		await b.load()
		a.recalled(['x'])
		await a.flush()
		time.set(3_000)
		b.recalled(['x', 'y'])
		await b.flush()
		expect(read(file).records).toEqual({
			x: { recalls: 2, selected: 0, lastRecalledAt: 3_000 },
			y: { recalls: 1, selected: 0, lastRecalledAt: 3_000 },
		})
		expect(b.get('x')?.recalls).toBe(2)
	})

	it('keeps what is set aside until it is restored, across a reload', async () => {
		const { file } = temp()
		const first = new MemoryUsage({ file, now: clock(7).now })
		await first.load()
		first.setAside(['m1', 'm2'])
		expect(first.isSetAside('m1')).toBe(true)
		await first.flush()

		const second = new MemoryUsage({ file, now: clock(9).now })
		await second.load()
		expect([...second.setAsideIds()].sort()).toEqual(['m1', 'm2'])
		second.restore('m1')
		expect(second.isSetAside('m1')).toBe(false)
		await second.flush()

		const third = new MemoryUsage({ file, now: clock(9).now })
		await third.load()
		expect([...third.setAsideIds()]).toEqual(['m2'])
	})

	it('writes nothing when nothing changed', async () => {
		const { file } = temp()
		const usage = new MemoryUsage({ file, now: clock().now })
		await usage.load()
		await usage.flush()
		expect(existsSync(file)).toBe(false)
	})

	it('never overwrites a sidecar it could not read, and writes once it can', async () => {
		const { file } = temp()
		const first = new MemoryUsage({ file, now: clock().now })
		await first.load()
		first.recalled(['a'])
		first.setAside(['a'])
		await first.flush()
		const before = readFileSync(file, 'utf8')

		let failing = true
		const fs: UsageFs = {
			...nodeUsageFs,
			readFile: (path) =>
				failing && path === file
					? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
					: nodeUsageFs.readFile(path),
		}
		const usage = new MemoryUsage({ file, now: clock(9_000).now, fs })
		await usage.load()
		expect(usage.state).toBe('unknown')
		usage.recalled(['b'])
		await usage.flush()
		// Left as it was, and the pending count is kept for later.
		expect(readFileSync(file, 'utf8')).toBe(before)
		expect(usage.dirty).toBe(true)

		failing = false
		await usage.flush()
		const after = read(file)
		expect(after.setAside.a).toBeDefined()
		expect(after.records.a.recalls).toBe(1)
		expect(after.records.b.recalls).toBe(1)
		expect(usage.dirty).toBe(false)
	})

	it('does not replace a corrupt sidecar it could not move aside', async () => {
		const { file } = temp()
		const first = new MemoryUsage({ file, now: clock().now })
		await first.load()
		first.recalled(['a'])
		await first.flush()
		writeFileSync(file, '{"version":1,"since":"soon"')
		const fs: UsageFs = {
			...nodeUsageFs,
			rename: (from, to) =>
				to.endsWith('.corrupt') ? Promise.reject(new Error('busy')) : nodeUsageFs.rename(from, to),
		}
		const usage = new MemoryUsage({ file, now: clock(5_000).now, fs })
		await usage.load()
		usage.recalled(['b'])
		await usage.flush()
		expect(readFileSync(file, 'utf8')).toBe('{"version":1,"since":"soon"')
	})
})
