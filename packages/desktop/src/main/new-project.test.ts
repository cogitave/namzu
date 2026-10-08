import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNewProject } from './new-project.js'

let documents: string
beforeEach(async () => {
	documents = await mkdtemp(join(tmpdir(), 'namzu-docs-'))
})
afterEach(async () => {
	await rm(documents, { recursive: true, force: true })
})

describe('createNewProject', () => {
	it('creates Documents/Namzu/New project and runs git init there', async () => {
		const ran: string[] = []
		const path = await createNewProject({ documents, git: async (cwd) => void ran.push(cwd) })
		expect(path).toBe(join(documents, 'Namzu', 'New project'))
		expect(await readdir(join(documents, 'Namzu'))).toEqual(['New project'])
		expect(ran).toEqual([path])
	})
	it('takes the next free suffix when the name is taken', async () => {
		await mkdir(join(documents, 'Namzu', 'New project'), { recursive: true })
		await mkdir(join(documents, 'Namzu', 'New project 2'))
		const path = await createNewProject({ documents, git: async () => undefined })
		expect(path).toBe(join(documents, 'Namzu', 'New project 3'))
	})
	it('fills a gap in the numbering', async () => {
		await mkdir(join(documents, 'Namzu', 'New project'), { recursive: true })
		await mkdir(join(documents, 'Namzu', 'New project 3'))
		expect(await createNewProject({ documents, git: async () => undefined })).toBe(
			join(documents, 'Namzu', 'New project 2'),
		)
	})
	it('still creates the folder when git is missing or fails', async () => {
		const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
		const path = await createNewProject({
			documents,
			git: async () => {
				throw missing
			},
		})
		expect(await readdir(path)).toEqual([])
	})
	it('reports a folder it cannot create', async () => {
		await expect(
			createNewProject({
				documents,
				mkdir: async (_path, options) => {
					if (!options.recursive) throw Object.assign(new Error('denied'), { code: 'EACCES' })
				},
			}),
		).rejects.toThrow('denied')
	})
	it('gives up with a message once every suffix is taken', async () => {
		await expect(
			createNewProject({
				documents,
				mkdir: async (_path, options) => {
					if (!options.recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
				},
			}),
		).rejects.toThrow(/is taken/)
	})
})
