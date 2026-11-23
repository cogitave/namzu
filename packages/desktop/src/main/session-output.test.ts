import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	stat,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProjectFiles } from './project-files.js'
import { describeOutputs, readOutput, resolveOutput, saveOutputCopy } from './session-output.js'

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

describe('what a card shows and where a copy goes', () => {
	const deps = {
		stat: async (path: string) => {
			try {
				return { size: (await stat(path)).size }
			} catch {
				return undefined
			}
		},
		head: async (path: string) => (await readFile(path, 'utf8')).slice(0, 4096),
	}
	it('describes only files the conversation owns, and says gone for the rest', async () => {
		await writeFile(join(folder, 'plan.md'), '# The plan\nbody')
		const access = { root: folder, written: [join(elsewhere, 'written.md')] }
		const result = await describeOutputs(
			access,
			['plan.md', join(elsewhere, 'written.md'), join(elsewhere, 'secret.txt'), 'gone.md', 4],
			deps,
		)
		expect(result).toEqual([
			{ path: 'plan.md', size: 15, preview: 'The plan' },
			{ path: join(elsewhere, 'written.md'), size: 9, preview: 'written' },
			{ path: join(elsewhere, 'secret.txt'), missing: true },
			{ path: 'gone.md', missing: true },
		])
		await expect(describeOutputs(access, 'plan.md', deps)).rejects.toThrow()
	})
	it('refuses a handed-over file whose link was re-pointed after the hand-over', async () => {
		const first = join(elsewhere, 'first.md')
		await writeFile(first, 'first')
		const link = join(elsewhere, 'handed.md')
		await symlink(first, link)
		const access = { root: folder, written: [{ path: link, real: await realpath(first) }] }
		expect((await resolveOutput(access, link)).absolute).toBe(await realpath(first))
		await unlink(link)
		await symlink(join(elsewhere, 'secret.txt'), link)
		await expect(resolveOutput(access, link)).rejects.toThrow(/not one this conversation wrote/)
		await expect(resolveOutput(access, join(elsewhere, 'secret.txt'))).rejects.toThrow(
			/not one this conversation wrote/,
		)
	})
	it('copies where the dialog says, and nowhere when it is closed', async () => {
		const access = { root: folder, written: [] }
		const target = join(elsewhere, 'copy.html')
		const copy = (from: string, to: string) => copyFile(from, to)
		expect(
			await saveOutputCopy(access, 'cafe/index.html', {
				choose: async (name) => {
					expect(name).toBe('index.html')
					return target
				},
				copy,
			}),
		).toEqual({ saved: true })
		expect(await readFile(target, 'utf8')).toBe('<h1>Ada</h1>')
		expect(
			await saveOutputCopy(access, 'cafe/index.html', { choose: async () => undefined, copy }),
		).toEqual({ saved: false })
		await expect(
			saveOutputCopy(access, join(elsewhere, 'secret.txt'), { choose: async () => target, copy }),
		).rejects.toThrow(/not one this conversation wrote/)
	})
})
