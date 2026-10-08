import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintChanges, folderFingerprint, partLabel } from './folder-fingerprint.js'
import { CONFIG_SECTIONS } from './folder-settings.js'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const folder = async (config?: unknown) => {
	const path = await mkdtemp(join(tmpdir(), 'namzu-fingerprint-'))
	roots.push(path)
	if (config !== undefined) await writeFile(join(path, 'namzu.config.json'), JSON.stringify(config))
	return path
}

describe('folderFingerprint', () => {
	it('is the same for the same folder, whatever the key order or an unrelated key', async () => {
		const one = await folder({ hooks: { a: 1, b: 2 }, model: 'x' })
		const two = await folder({ model: 'y', hooks: { b: 2, a: 1 } })
		expect((await folderFingerprint(one)).digest).toBe((await folderFingerprint(two)).digest)
	})
	it('names which section changed, was added or was removed', async () => {
		const path = await folder({ hooks: { a: 1 }, sandbox: { mode: 'on' } })
		const before = await folderFingerprint(path)
		await writeFile(
			join(path, 'namzu.config.json'),
			JSON.stringify({ hooks: { a: 2 }, mcpServers: { s: {} } }),
		)
		const after = await folderFingerprint(path)
		expect(after.digest).not.toBe(before.digest)
		expect(fingerprintChanges(before, after)).toEqual([
			'hooks changed',
			'MCP servers added',
			'sandbox settings removed',
		])
	})
	it('notices an edit that keeps the counts, which name-and-count detection cannot', async () => {
		const path = await folder()
		await mkdir(join(path, '.namzu', 'plugins'), { recursive: true })
		await writeFile(join(path, '.namzu', 'plugins', 'p.js'), 'one')
		const before = await folderFingerprint(path)
		await writeFile(join(path, '.namzu', 'plugins', 'p.js'), 'two')
		const after = await folderFingerprint(path)
		expect(fingerprintChanges(before, after)).toEqual(['plugin p.js changed'])
	})
	it('names added commands and nested plugin directories', async () => {
		const path = await folder()
		const before = await folderFingerprint(path)
		await mkdir(join(path, '.namzu', 'commands'), { recursive: true })
		await mkdir(join(path, '.namzu', 'plugins', 'tool'), { recursive: true })
		await writeFile(join(path, '.namzu', 'commands', 'go.md'), 'x')
		await writeFile(join(path, '.namzu', 'plugins', 'tool', 'index.js'), 'x')
		const after = await folderFingerprint(path)
		expect(fingerprintChanges(before, after)).toEqual(['command go.md added', 'plugin tool added'])
		await writeFile(join(path, '.namzu', 'plugins', 'tool', 'index.js'), 'y')
		expect(fingerprintChanges(after, await folderFingerprint(path))).toEqual([
			'plugin tool changed',
		])
	})
	it('ignores a change outside the digested sections', async () => {
		const path = await folder({ model: 'a' })
		const before = await folderFingerprint(path)
		await writeFile(join(path, 'namzu.config.json'), JSON.stringify({ model: 'b' }))
		expect((await folderFingerprint(path)).digest).toBe(before.digest)
	})
	it('sees a link retargeted, and an edit to the file behind a link', async () => {
		const path = await folder()
		const one = await folder()
		const two = await folder()
		await writeFile(join(one, 'p.js'), 'a')
		await writeFile(join(two, 'p.js'), 'a')
		await mkdir(join(path, '.namzu', 'plugins'), { recursive: true })
		const link = join(path, '.namzu', 'plugins', 'p')
		await symlink(one, link)
		const before = await folderFingerprint(path)
		await writeFile(join(one, 'p.js'), 'b')
		const edited = await folderFingerprint(path)
		expect(fingerprintChanges(before, edited)).toEqual(['plugin p changed'])
		await rm(link)
		await symlink(two, link)
		expect(fingerprintChanges(edited, await folderFingerprint(path))).toEqual(['plugin p changed'])
	})
	it('sees a same-size edit of a large file with its mtime restored', async () => {
		const path = await folder()
		await mkdir(join(path, '.namzu', 'commands'), { recursive: true })
		const file = join(path, '.namzu', 'commands', 'big.md')
		await writeFile(file, Buffer.alloc(300 * 1024, 'a'))
		const when = new Date(1_000_000)
		await utimes(file, when, when)
		const before = await folderFingerprint(path)
		const bytes = Buffer.alloc(300 * 1024, 'a')
		bytes.write('zzzz', 100)
		await writeFile(file, bytes)
		await utimes(file, when, when)
		expect(fingerprintChanges(before, await folderFingerprint(path))).toEqual([
			'command big.md changed',
		])
	})
	it('sees an edit when the config is larger than a megabyte', async () => {
		const path = await folder({ pad: 'x'.repeat(2 * 1024 * 1024), hooks: { a: 1 } })
		const before = await folderFingerprint(path)
		await writeFile(
			join(path, 'namzu.config.json'),
			JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024), hooks: { a: 2 } }),
		)
		expect(fingerprintChanges(before, await folderFingerprint(path))).toEqual(['hooks changed'])
	})
	it('covers skills and agents', async () => {
		const path = await folder()
		await mkdir(join(path, '.namzu', 'skills', 's'), { recursive: true })
		await writeFile(join(path, '.namzu', 'skills', 's', 'SKILL.md'), 'one')
		const before = await folderFingerprint(path)
		await writeFile(join(path, '.namzu', 'skills', 's', 'SKILL.md'), 'two')
		expect(fingerprintChanges(before, await folderFingerprint(path))).toEqual(['skill s changed'])
	})
	it('reports an unreadable config rather than treating it as unchanged', async () => {
		const path = await folder()
		const before = await folderFingerprint(path)
		await writeFile(join(path, 'namzu.config.json'), '{not json')
		expect(fingerprintChanges(before, await folderFingerprint(path))).toEqual([
			'namzu.config.json added',
		])
	})
})

describe('the section list', () => {
	it('has a label for every section findAutoRunSettings knows', () => {
		for (const [key] of CONFIG_SECTIONS)
			expect(partLabel(`config:${key}`)).not.toBe(key.length ? `config:${key}` : '')
	})
	it('equals the CLI project digest list, which Desktop cannot import', async () => {
		const source = await readFile(
			fileURLToPath(new URL('../../../cli/src/schedule/store/digest.ts', import.meta.url)),
			'utf8',
		)
		const block = /DIGESTED_SECTIONS = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
		const cli = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
		expect(CONFIG_SECTIONS.map(([key]) => key)).toEqual(cli)
	})
})
