import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createEngineModelCache } from './model-cache.js'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function home() {
	const path = await mkdtemp(join(tmpdir(), 'namzu-engine-models-'))
	directories.push(path)
	return path
}
const rows = [
	{ id: 'sol', label: 'Sol', effortLevels: ['low', 'high'], defaultEffort: 'high', default: true },
	{ id: 'luna', label: 'Luna' },
] as never

it('keeps the last good list per engine build and reads it back from a new cache object', async () => {
	const path = join(await home(), 'nested', 'engine-models.json')
	await createEngineModelCache(path).write('codex-cli', 'build-a', rows, 1_000)
	const again = createEngineModelCache(path)
	expect(await again.read('codex-cli', 'build-a')).toEqual({ rows, at: 1_000 })
	// Another build, and another engine, have nothing.
	expect(await again.read('codex-cli', 'build-b')).toBeUndefined()
	expect(await again.read('claude-code', 'build-a')).toBeUndefined()
})

it('writes through a temporary file and leaves nothing behind', async () => {
	const directory = await home()
	await createEngineModelCache(join(directory, 'engine-models.json')).write(
		'codex-cli',
		'a',
		rows,
		1,
	)
	expect(await readdir(directory)).toEqual(['engine-models.json'])
})

it('keeps the eight newest lists', async () => {
	const path = join(await home(), 'engine-models.json')
	const cache = createEngineModelCache(path)
	for (let build = 0; build < 10; build++) await cache.write('codex-cli', `b${build}`, rows, build)
	expect(await cache.read('codex-cli', 'b0')).toBeUndefined()
	expect(await cache.read('codex-cli', 'b1')).toBeUndefined()
	expect(await cache.read('codex-cli', 'b2')).toBeDefined()
	expect(await cache.read('codex-cli', 'b9')).toBeDefined()
})

it('ignores a corrupt, foreign or oversize file, and the next write replaces it', async () => {
	const path = join(await home(), 'engine-models.json')
	const cache = createEngineModelCache(path)
	for (const content of [
		'{not json',
		'[]',
		JSON.stringify({ version: 9, entries: {} }),
		'x'.repeat(300_000),
	]) {
		await writeFile(path, content)
		expect(await cache.read('codex-cli', 'a')).toBeUndefined()
	}
	await cache.write('codex-cli', 'a', rows, 5)
	expect(await cache.read('codex-cli', 'a')).toEqual({ rows, at: 5 })
})

it('drops an entry with a malformed row and never carries a foreign field through', async () => {
	const path = join(await home(), 'engine-models.json')
	const cache = createEngineModelCache(path)
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			entries: {
				[JSON.stringify(['codex-cli', 'bad'])]: { at: 1, rows: [{ id: 3, label: 'x' }] },
				[JSON.stringify(['codex-cli', 'extra'])]: {
					at: 2,
					rows: [{ id: 'sol', label: 'Sol', token: 'SECRET', path: 'C:\\Users\\Private' }],
				},
			},
		}),
	)
	expect(await cache.read('codex-cli', 'bad')).toBeUndefined()
	expect(await cache.read('codex-cli', 'extra')).toEqual({
		rows: [{ id: 'sol', label: 'Sol' }],
		at: 2,
	})
	await cache.write('codex-cli', 'extra', [{ id: 'sol', label: 'Sol' }] as never, 3)
	expect(await readFile(path, 'utf8')).not.toContain('SECRET')
})
