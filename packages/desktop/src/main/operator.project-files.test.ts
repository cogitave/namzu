import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Operator } from './operator.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'namzu-operator-files-')))
	directories.push(base)
	const project = join(base, 'project')
	await mkdir(join(project, 'src'), { recursive: true })
	await writeFile(join(project, 'src', 'a.ts'), 'export {}\n')
	await writeFile(join(base, 'secret.txt'), 'secret')
	await symlink(join(base, 'secret.txt'), join(project, 'leak.txt'))
	const openIn = {
		editors: vi.fn().mockResolvedValue([{ id: 'vscode', label: 'VS Code', executable: '/x/code' }]),
		open: vi.fn().mockResolvedValue(undefined),
	}
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env },
		},
		() => {},
		base,
		undefined,
		undefined,
		openIn,
	)
	owners.push(owner)
	const view = await owner.openProject(project)
	return { owner, view, project, openIn }
}

it('lists, indexes, reads and resolves only inside the trusted project', async () => {
	const { owner, view, project } = await setup()
	expect((await owner.listProjectDirectory(view.id, '')).map((entry) => entry.path)).toEqual([
		'src',
	])
	expect((await owner.projectFileIndex(view.id)).paths).toEqual(['src/a.ts'])
	expect(await owner.readProjectFile(view.id, 'src/a.ts')).toMatchObject({ kind: 'text' })
	await expect(owner.readProjectFile(view.id, 'leak.txt')).rejects.toThrow('not inside')
	await expect(owner.readProjectFile(view.id, '../secret.txt')).rejects.toThrow('not inside')
	expect(
		await owner.resolveProjectLinks(view.id, [`${join(project, 'src', 'a.ts')}:3`, 'leak.txt']),
	).toEqual([
		{ ref: `${join(project, 'src', 'a.ts')}:3`, path: 'src/a.ts', line: 3 },
		{ ref: 'leak.txt' },
	])
})

it('refuses an unknown project id and hands confined absolute paths to the opener', async () => {
	const { owner, view, project, openIn } = await setup()
	await expect(owner.listProjectDirectory('nope', '')).rejects.toThrow()
	await owner.openProjectPath(view.id, 'src/a.ts', 'editor', 4)
	expect(openIn.open).toHaveBeenCalledWith(join(project, 'src', 'a.ts'), 'file', 'editor', 4)
	await owner.openProjectPath(view.id, '', 'file-manager')
	expect(openIn.open).toHaveBeenLastCalledWith(project, 'directory', 'file-manager', undefined)
	await expect(owner.openProjectPath(view.id, '../x', 'editor')).rejects.toThrow('not inside')
	await expect(owner.openProjectPath(view.id, 'src', 'shell' as never)).rejects.toThrow(
		'not supported',
	)
	expect(await owner.projectEditors()).toEqual([{ id: 'vscode', label: 'VS Code' }])
})
