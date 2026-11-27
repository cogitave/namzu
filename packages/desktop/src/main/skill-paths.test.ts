import { describe, expect, it } from 'vitest'
import {
	OTHER_FILE_SYSTEM_MESSAGE,
	SKILL_PATH_FILE_MAX_BYTES,
	type SkillPathStat,
	checkSkillPath,
	createSkillPathRegistry,
	enginePath,
} from './skill-paths.js'

type Entry = { kind: 'file' | 'dir' | 'link' | 'other'; size?: number }
const stat =
	(entries: Record<string, Entry>): SkillPathStat =>
	async (path) => {
		const entry = entries[path]
		if (!entry) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
		return {
			isFile: () => entry.kind === 'file',
			isDirectory: () => entry.kind === 'dir',
			isSymbolicLink: () => entry.kind === 'link',
			size: entry.size ?? 10,
		}
	}

const entries: Record<string, Entry> = {
	'/in/a.md': { kind: 'file' },
	'/in/b.zip': { kind: 'file' },
	'/in/folder': { kind: 'dir' },
	'/in/link.md': { kind: 'link' },
	'/in/big.zip': { kind: 'file', size: SKILL_PATH_FILE_MAX_BYTES + 1 },
	'/in/edge.zip': { kind: 'file', size: SKILL_PATH_FILE_MAX_BYTES },
	'/in/notes.txt': { kind: 'file' },
	'/in/pipe': { kind: 'other' },
}

describe('checking a path', () => {
	it('accepts a skill file or a folder and refuses everything else with a sentence', async () => {
		const check = (p: string) => checkSkillPath(p, stat(entries))
		expect(await check('/in/a.md')).toEqual({ kind: 'file' })
		expect(await check('/in/folder')).toEqual({ kind: 'folder' })
		expect(await check('/in/edge.zip')).toEqual({ kind: 'file' })
		expect(await check('/in/link.md')).toEqual({ error: expect.stringContaining('is a link') })
		expect(await check('/in/big.zip')).toEqual({ error: expect.stringContaining('30 MB') })
		expect(await check('/in/notes.txt')).toEqual({ error: expect.stringContaining('.skill, .zip') })
		expect(await check('/in/pipe')).toEqual({ error: expect.stringContaining('not a file') })
		expect(await check('/in/missing.md')).toEqual({ error: expect.stringContaining('could not') })
		expect(await check('relative.md')).toEqual({ error: 'That path cannot be used.' })
		expect(await check('/in/a\0.md')).toEqual({ error: 'That path cannot be used.' })
	})
})

describe('the path registry', () => {
	const registry = () => createSkillPathRegistry({ stat: stat(entries) })

	it('registers only what passed the check and keeps them for the window', async () => {
		const r = registry()
		const chosen = await r.register('w1', ['/in/a.md', '/in/link.md', '/in/folder'])
		expect(chosen).toEqual([
			{ fileName: 'a.md', path: '/in/a.md', kind: 'file' },
			{ fileName: 'link.md', error: expect.stringContaining('is a link') },
			{ fileName: 'folder', path: '/in/folder', kind: 'folder' },
		])
		expect(r.take('w1', ['/in/a.md', '/in/folder'])).toEqual({
			paths: ['/in/a.md', '/in/folder'],
		})
		// Staging again (a second file added, a card removed, a retry) sends the same paths.
		expect(r.take('w1', ['/in/a.md'])).toEqual({ paths: ['/in/a.md'] })
	})

	it('lets the page stage again after adding a file, removing a card or retrying', async () => {
		const r = registry()
		await r.register('w1', ['/in/a.md'])
		expect(r.take('w1', ['/in/a.md'])).toEqual({ paths: ['/in/a.md'] })
		await r.register('w1', ['/in/folder'])
		expect(r.take('w1', ['/in/a.md', '/in/folder'])).toEqual({
			paths: ['/in/a.md', '/in/folder'],
		})
		expect(r.take('w1', ['/in/folder'])).toEqual({ paths: ['/in/folder'] })
		expect(r.take('w1', ['/in/a.md', '/in/folder'])).toEqual({
			paths: ['/in/a.md', '/in/folder'],
		})
	})

	it('refuses a path the page made up, one from another window, and one that failed the check', async () => {
		const r = registry()
		await r.register('w1', ['/in/a.md', '/in/link.md'])
		expect(r.take('w1', ['/etc/passwd'])).toEqual({ error: 'Choose the file again.' })
		expect(r.take('w2', ['/in/a.md'])).toEqual({ error: 'Choose the file again.' })
		expect(r.take('w1', ['/in/link.md'])).toEqual({ error: 'Choose the file again.' })
		expect(r.take('w1', ['/in/a.md', '/etc/passwd'])).toEqual({ error: 'Choose the file again.' })
		expect(r.take('w1', ['/in/a.md'])).toEqual({ paths: ['/in/a.md'] })
	})

	it('takes 1 to 20 strings', async () => {
		const r = registry()
		await r.register('w1', ['/in/a.md'])
		for (const bad of [[], 'x', [5], Array.from({ length: 21 }, () => '/in/a.md'), undefined])
			expect(r.take('w1', bad)).toEqual({ error: 'Choose between 1 and 20 skills.' })
	})

	it('registers at most twenty at a time and forgets a closed window', async () => {
		const r = registry()
		const many = await r.register(
			'w1',
			Array.from({ length: 30 }, () => '/in/a.md'),
		)
		expect(many.length).toBe(20)
		r.forget('w1')
		expect(r.take('w1', ['/in/a.md'])).toEqual({ error: 'Choose the file again.' })
	})

	it('translates for an engine on another file system, or says why not', async () => {
		expect(enginePath('C:\\in\\a.md', 'wsl')).toEqual({ path: '/mnt/c/in/a.md' })
		expect(enginePath('\\\\wsl$\\Ubuntu\\home\\me\\a.md', 'wsl')).toEqual({
			path: '/home/me/a.md',
		})
		expect(enginePath('\\\\wsl$\\Ubuntu\\home\\me\\a.md', 'wsl', 'ubuntu')).toEqual({
			path: '/home/me/a.md',
		})
		expect(enginePath('\\\\wsl$\\Other\\home\\me\\a.md', 'wsl', 'Ubuntu')).toEqual({
			error: OTHER_FILE_SYSTEM_MESSAGE,
		})
		expect(enginePath('\\\\server\\share\\a.md', 'wsl')).toEqual({
			error: OTHER_FILE_SYSTEM_MESSAGE,
		})
		expect(enginePath('/in/a.md', 'local')).toEqual({ path: '/in/a.md' })
		const r = createSkillPathRegistry({ stat: stat(entries), engine: () => 'wsl' })
		await r.register('w1', ['/in/a.md'])
		expect(r.take('w1', ['/in/a.md'])).toEqual({ error: OTHER_FILE_SYSTEM_MESSAGE })
	})
})
