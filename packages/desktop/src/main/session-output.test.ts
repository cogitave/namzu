import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProjectFiles } from './project-files.js'
import { readOutput, resolveOutput } from './session-output.js'

/** The host reads a file for the preview pane only when the conversation owns it. */

let folder: string
let elsewhere: string
beforeEach(async () => {
	const base = await mkdtemp(join(tmpdir(), 'namzu-output-'))
	folder = join(base, 'work')
	elsewhere = join(base, 'elsewhere')
	await mkdir(join(folder, 'cafe'), { recursive: true })
	await mkdir(elsewhere, { recursive: true })
	await writeFile(join(folder, 'cafe', 'index.html'), '<h1>Ada</h1>')
	await writeFile(join(elsewhere, 'secret.txt'), 'private')
	await writeFile(join(elsewhere, 'written.md'), '# written')
})

describe('which files the preview may read', () => {
	it('reads a file inside the work folder by relative or absolute path', async () => {
		const access = { root: folder, written: [] }
		const files = new ProjectFiles()
		const byRelative = await readOutput(access, 'cafe/index.html', files)
		expect(byRelative.text).toBe('<h1>Ada</h1>')
		const byAbsolute = await readOutput(access, join(folder, 'cafe', 'index.html'), files)
		expect(byAbsolute.text).toBe('<h1>Ada</h1>')
	})

	it('reads a file a turn wrote outside the folder, and only that file', async () => {
		const access = { root: folder, written: [join(elsewhere, 'written.md')] }
		const files = new ProjectFiles()
		expect((await readOutput(access, join(elsewhere, 'written.md'), files)).text).toBe('# written')
		await expect(readOutput(access, join(elsewhere, 'secret.txt'), files)).rejects.toThrow(
			/not one this conversation wrote/,
		)
	})

	it('refuses a path that leaves the folder, and one nothing wrote', async () => {
		const access = { root: folder, written: [] }
		for (const path of [
			'../elsewhere/secret.txt',
			join(elsewhere, 'secret.txt'),
			'/etc/hostname',
			'',
			'cafe/\u0000x',
		])
			await expect(resolveOutput(access, path), path).rejects.toThrow()
	})

	it('refuses a link inside the folder that points out of it', async () => {
		await symlink(join(elsewhere, 'secret.txt'), join(folder, 'link.txt'))
		await expect(resolveOutput({ root: folder, written: [] }, 'link.txt')).rejects.toThrow(
			/not one this conversation wrote/,
		)
	})

	it('never reads inside .git', async () => {
		await mkdir(join(folder, '.git'), { recursive: true })
		await writeFile(join(folder, '.git', 'config'), 'x')
		await expect(resolveOutput({ root: folder, written: [] }, '.git/config')).rejects.toThrow()
	})

	it('says plainly when the file is gone', async () => {
		await expect(resolveOutput({ root: folder, written: [] }, 'nope.html')).rejects.toThrow(
			/was not found/,
		)
	})
})
