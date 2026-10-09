import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator, folderHasNoWork } from './operator.js'
import { PROJECT_NAME_LIMIT, ProjectNameStore, projectNameProblem } from './project-names.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const temp = async (prefix: string) => {
	const path = await mkdtemp(join(tmpdir(), prefix))
	directories.push(path)
	return path
}

async function setup(names: ProjectNameStore, files: string[] = []) {
	const root = await temp('namzu-rename-root-')
	const path = await temp('namzu-rename-folder-')
	for (const file of files) await mkdir(join(path, file), { recursive: true })
	const events: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env },
		},
		(event) => events.push(event),
		root,
		undefined,
		undefined,
		undefined,
		undefined,
		{ projectNames: names },
	)
	owners.push(owner)
	return { owner, path, root, events }
}

describe('project names', () => {
	it('refuses an empty, over-long or control-character name in plain words', () => {
		expect(projectNameProblem('   ')).toBe('Give the project a name.')
		expect(projectNameProblem('x'.repeat(PROJECT_NAME_LIMIT + 1))).toMatch(/characters or fewer/)
		expect(projectNameProblem('a\u0007b')).toMatch(/control characters/)
		expect(projectNameProblem('Işık’s site')).toBeUndefined()
	})
	it('keeps names across a new store on the same file and clears one on request', async () => {
		const root = await temp('namzu-names-')
		const file = join(root, 'names.json')
		const first = new ProjectNameStore(file)
		first.set('/a', 'Alpha')
		expect(new ProjectNameStore(file).get('/a')).toBe('Alpha')
		first.set('/a', undefined)
		expect(new ProjectNameStore(file).get('/a')).toBeUndefined()
	})
	it('ignores a damaged file instead of failing to start', async () => {
		const root = await temp('namzu-names-bad-')
		const file = join(root, 'names.json')
		await writeFile(file, '{not json')
		expect(new ProjectNameStore(file).get('/a')).toBeUndefined()
	})
})

describe('renameProject', () => {
	it('changes the shown name only, tells the window, and survives a reopen', async () => {
		const root = await temp('namzu-names-')
		const names = new ProjectNameStore(join(root, 'names.json'))
		const { owner, path, events } = await setup(names)
		const project = await owner.openProject(path)
		expect(project.name).toBe(basename(path))
		const renamed = owner.renameProject(project.id, '  My plan  ')
		expect(renamed.name).toBe('My plan')
		expect(renamed.path).toBe(path)
		expect(owner.listProjects().find((item) => item.id === project.id)?.name).toBe('My plan')
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: 'connection',
				project: expect.objectContaining({ id: project.id, name: 'My plan' }),
			}),
		)
		expect(new ProjectNameStore(join(root, 'names.json')).get(path)).toBe('My plan')
		// Clearing brings the folder's own name back.
		expect(owner.renameProject(project.id, '').name).toBe(basename(path))
		expect(names.get(path)).toBeUndefined()
	})
	it('refuses an unknown project and a bad name without changing anything', async () => {
		const root = await temp('namzu-names-')
		const names = new ProjectNameStore(join(root, 'names.json'))
		const { owner, path } = await setup(names)
		const project = await owner.openProject(path)
		expect(() => owner.renameProject('nope', 'x')).toThrow('no longer in Namzu')
		expect(() => owner.renameProject(project.id, 'x'.repeat(PROJECT_NAME_LIMIT + 1))).toThrow(
			/characters or fewer/,
		)
		expect(owner.listProjects().find((item) => item.id === project.id)?.name).toBe(basename(path))
	})
	it('marks a folder with nothing the person made, and not one with files', async () => {
		const root = await temp('namzu-names-')
		const names = new ProjectNameStore(join(root, 'names.json'))
		const empty = await setup(names, ['.git'])
		expect((await empty.owner.openProject(empty.path)).emptyFolder).toBe(true)
		const used = await setup(names, ['src'])
		expect((await used.owner.openProject(used.path)).emptyFolder).toBeUndefined()
	})
})

describe('folderHasNoWork', () => {
	it('treats git and system files as nothing and a missing folder as not empty', async () => {
		const path = await temp('namzu-empty-')
		expect(await folderHasNoWork(path)).toBe(true)
		await writeFile(join(path, 'desktop.ini'), '')
		expect(await folderHasNoWork(path)).toBe(true)
		await writeFile(join(path, 'notes.txt'), '')
		expect(await folderHasNoWork(path)).toBe(false)
		expect(await folderHasNoWork(join(path, 'gone'))).toBe(false)
	})
})
