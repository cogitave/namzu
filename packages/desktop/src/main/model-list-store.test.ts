import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { type ModelListFs, ModelListStore, modelListKey } from './model-list-store.js'

const directories: string[] = []
afterEach(async () => {
	vi.useRealTimers()
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const dir = async () => {
	const path = await mkdtemp(join(tmpdir(), 'namzu-model-store-'))
	directories.push(path)
	return path
}
const rows = (...ids: string[]) => ({
	models: ids.map((id) => ({ id, label: id.toUpperCase() })),
	notice: null,
})
const key = (id = 'zen', label = 'Zen', engine = 'namzu') => modelListKey({ engine, id, label })

it('round-trips lists through the file and a second store reads them back', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-10-08T09:00:00.000Z'))
	const path = await dir()
	const first = new ModelListStore(path)
	const stored = first.put(key(), {
		models: [{ id: 'a', label: 'A', note: '(free)', default: true }],
		notice: null,
	})
	expect(stored.changed).toBe(false)
	expect(stored.entry).toEqual({
		rows: { models: [{ id: 'a', label: 'A', note: '(free)', default: true }], notice: null },
		fetchedAt: Date.parse('2026-10-08T09:00:00.000Z'),
		firstSeen: {},
	})
	expect(new ModelListStore(path).get(key())).toEqual(stored.entry)
	expect(await readdir(path)).toEqual(['model-lists.json'])
})

it("keeps the source's own current flag through the file", async () => {
	const path = await dir()
	const list = {
		models: [
			{ id: 'opus', label: 'Opus 5.5', current: true as const },
			{ id: 'claude-opus-5', label: 'Opus 5' },
		],
		notice: null,
	}
	new ModelListStore(path).put(key(), list)
	expect(new ModelListStore(path).get(key())?.rows).toEqual(list)
})

it('stamps only ids absent from the previous list, once, and reports real changes', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-10-08T09:00:00.000Z'))
	const store = new ModelListStore(await dir())
	store.put(key(), rows('a', 'b'))
	vi.setSystemTime(new Date('2026-10-09T09:00:00.000Z'))
	expect(store.put(key(), rows('a', 'b')).changed).toBe(false)
	vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'))
	const added = store.put(key(), rows('a', 'b', 'c'))
	expect(added.changed).toBe(true)
	expect(added.entry.firstSeen).toEqual({ c: '2026-10-10T09:00:00.000Z' })
	vi.setSystemTime(new Date('2026-10-11T09:00:00.000Z'))
	const again = store.put(key(), rows('a', 'c'))
	expect(again.changed).toBe(true)
	expect(again.entry.firstSeen).toEqual({ c: '2026-10-10T09:00:00.000Z' })
})

it('leaves the old file intact when the atomic write fails', async () => {
	const path = await dir()
	const good = new ModelListStore(path)
	good.put(key(), rows('a'))
	const before = await readFile(join(path, 'model-lists.json'), 'utf8')
	const failing: ModelListFs = {
		mkdirSync: () => {},
		readFileSync: () => Buffer.from(before, 'utf8'),
		statSync: () => ({ size: 1 }),
		writeFileSync: () => {
			throw new Error('disk full')
		},
		renameSync: () => {
			throw new Error('unreachable')
		},
		unlinkSync: () => {},
	}
	const errors: unknown[] = []
	const store = new ModelListStore(path, { fs: failing, onError: (error) => errors.push(error) })
	// The list is still usable in memory even though it could not be saved.
	expect(() => store.put(key('other', 'Other'), rows('b'))).not.toThrow()
	expect(errors).toHaveLength(1)
	expect(await readFile(join(path, 'model-lists.json'), 'utf8')).toBe(before)
})

it('removes the temporary file when the rename fails', async () => {
	const path = await dir()
	const errors: unknown[] = []
	const store = new ModelListStore(path, {
		fs: {
			mkdirSync: () => {},
			readFileSync: () => {
				throw new Error('missing')
			},
			statSync: () => {
				throw new Error('missing')
			},
			writeFileSync: (file) => writeFileSync(file, 'partial'),
			renameSync: () => {
				throw new Error('rename failed')
			},
			unlinkSync: (file) => rmSync(file, { force: true }),
		},
		onError: (error) => errors.push(error),
	})
	store.put(key(), rows('a'))
	expect(errors).toHaveLength(1)
	expect(await readdir(path)).toEqual([])
})

it('ignores a corrupt, foreign, oversize or malformed file and rewrites it on the next success', async () => {
	const bad = [
		'not json',
		JSON.stringify({ version: 2, entries: {} }),
		JSON.stringify([]),
		JSON.stringify({
			version: 1,
			entries: { k: { rows: { models: 'x', notice: null }, fetchedAt: 1, firstSeen: {} } },
		}),
		JSON.stringify({
			version: 1,
			entries: {
				k: {
					rows: { models: [{ id: 'a', label: 'A' }], notice: null },
					fetchedAt: 'soon',
					firstSeen: {},
				},
			},
		}),
		JSON.stringify({
			version: 1,
			entries: {
				k: {
					rows: { models: [{ id: 'a', label: 'A' }], notice: null },
					fetchedAt: 1,
					firstSeen: { a: 5 },
				},
			},
		}),
		`{"version":1,"entries":{},"pad":"${'x'.repeat(1024 * 1024)}"}`,
	]
	for (const content of bad) {
		const path = await dir()
		await writeFile(join(path, 'model-lists.json'), content)
		const store = new ModelListStore(path)
		expect(store.get('k')).toBeUndefined()
		store.put(key(), rows('a'))
		expect(new ModelListStore(path).get(key())?.rows.models).toEqual(rows('a').models)
	}
})

it('keeps at most 64 lists and drops the oldest first', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'))
	const path = await dir()
	const store = new ModelListStore(path)
	for (let index = 0; index < 66; index++) {
		store.put(key(`p${index}`, `P${index}`), rows('a'))
		vi.setSystemTime(Date.now() + 1000)
	}
	expect(store.get(key('p0', 'P0'))).toBeUndefined()
	expect(store.get(key('p1', 'P1'))).toBeUndefined()
	expect(store.get(key('p2', 'P2'))).toBeDefined()
	expect(store.get(key('p65', 'P65'))).toBeDefined()
	const file = JSON.parse(await readFile(join(path, 'model-lists.json'), 'utf8'))
	expect(Object.keys(file.entries)).toHaveLength(64)
})

it('stays under one mebibyte by dropping older lists, and refuses one list that is too big alone', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'))
	const path = await dir()
	const store = new ModelListStore(path)
	const big = (id: string) => ({
		models: Array.from({ length: 1500 }, (_, index) => ({
			id: `${id}-${index}`,
			label: 'x'.repeat(100),
		})),
		notice: null,
	})
	for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
		store.put(key(id, id), big(id))
		vi.setSystemTime(Date.now() + 1000)
	}
	expect((await readFile(join(path, 'model-lists.json'))).length).toBeLessThanOrEqual(1024 * 1024)
	expect(store.get(key('a', 'a'))).toBeUndefined()
	expect(store.get(key('g', 'g'))).toBeDefined()
	const huge = {
		models: Array.from({ length: 4000 }, (_, index) => ({
			id: `m${index}`,
			label: 'y'.repeat(380),
		})),
		notice: null,
	}
	store.put(key('huge', 'huge'), huge)
	expect(store.get(key('huge', 'huge'))).toBeUndefined()
})

it('derives a different key from the engine, provider id or label, never from a model choice', () => {
	const base = key()
	expect(key()).toBe(base)
	expect(key('zen-go')).not.toBe(base)
	expect(key('zen', 'Zen account')).not.toBe(base)
	expect(key('zen', 'Zen', 'codex-cli')).not.toBe(base)
})

it('prunes an engine to the keys still offered, and leaves other engines alone', async () => {
	const path = await dir()
	const store = new ModelListStore(path)
	store.put(key('zen'), rows('a'))
	store.put(key('zen', 'Zen (other account)'), rows('b'))
	store.put(key('codex-cli', 'codex-cli', 'codex-cli'), rows('c'))
	expect(store.prune('namzu', new Set([key('zen')]))).toBe(true)
	const reread = new ModelListStore(path)
	expect(reread.get(key('zen'))).toBeDefined()
	expect(reread.get(key('zen', 'Zen (other account)'))).toBeUndefined()
	expect(reread.get(key('codex-cli', 'codex-cli', 'codex-cli'))).toBeDefined()
	expect(store.prune('namzu', new Set([key('zen')]))).toBe(false)
})

it('forgets every list of an engine whatever build it came from, and only that engine', async () => {
	const path = await dir()
	const store = new ModelListStore(path)
	const build = (identity: string) =>
		modelListKey({ engine: 'codex-cli', id: 'codex-cli', label: 'Codex CLI', identity })
	store.put(build('old'), rows('a'))
	store.put(build('new'), rows('b'))
	store.put(key('zen'), rows('c'))
	expect(store.forgetEngine('codex-cli')).toBe(true)
	const reread = new ModelListStore(path)
	expect(reread.get(build('old'))).toBeUndefined()
	expect(reread.get(build('new'))).toBeUndefined()
	expect(reread.get(key('zen'))).toBeDefined()
	expect(store.forgetEngine('codex-cli')).toBe(false)
})

it('keeps the Zen group on a stored row and still reads a row saved without one', async () => {
	const path = await dir()
	new ModelListStore(path).put(key(), {
		models: [
			{ id: 'f', label: 'F', group: 'free' },
			{ id: 'k', label: 'K', group: 'key' },
			{ id: 'u', label: 'U' },
		],
		notice: null,
	})
	expect(new ModelListStore(path).get(key())?.rows.models).toEqual([
		{ id: 'f', label: 'F', group: 'free' },
		{ id: 'k', label: 'K', group: 'key' },
		{ id: 'u', label: 'U' },
	])
	const withEntry = async (rows: unknown) => {
		const other = await dir()
		await writeFile(
			join(other, 'model-lists.json'),
			JSON.stringify({
				version: 1,
				entries: { k: { rows: { models: [rows], notice: null }, fetchedAt: 1, firstSeen: {} } },
			}),
		)
		return new ModelListStore(other).get('k')
	}
	expect((await withEntry({ id: 'a', label: 'A', note: '(free)' }))?.rows.models).toEqual([
		{ id: 'a', label: 'A', note: '(free)' },
	])
	expect(await withEntry({ id: 'a', label: 'A', group: 'paid' })).toBeUndefined()
})

it('keys a list by the engine build when one is named, and leaves other keys as they were', () => {
	const plain = modelListKey({ engine: 'codex-cli', id: 'codex-cli', label: 'Codex CLI' })
	const buildA = modelListKey({
		engine: 'codex-cli',
		id: 'codex-cli',
		label: 'Codex CLI',
		identity: 'a',
	})
	const buildB = modelListKey({
		engine: 'codex-cli',
		id: 'codex-cli',
		label: 'Codex CLI',
		identity: 'b',
	})
	expect(new Set([plain, buildA, buildB]).size).toBe(3)
	expect(buildA.startsWith('codex-cli/codex-cli/')).toBe(true)
	// Without an identity the key is the one earlier launches stored.
	expect(modelListKey({ engine: 'zen', id: 'zen', label: 'Zen' })).toBe(
		modelListKey({ engine: 'zen', id: 'zen', label: 'Zen', identity: undefined }),
	)
})
