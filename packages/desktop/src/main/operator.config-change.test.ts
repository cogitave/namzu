import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Operator } from './operator.js'
import type { FolderTrustGuard } from './trusted-folders.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup(guard: FolderTrustGuard) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-config-change-'))
	const path = await mkdtemp(join(tmpdir(), 'namzu-config-change-folder-'))
	directories.push(root, path)
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env },
		},
		() => {},
		root,
		undefined,
		undefined,
		undefined,
		guard,
	)
	owners.push(owner)
	return { owner, path }
}

it('treats a trusted folder whose settings changed as untrusted until trust is confirmed again', async () => {
	let changes = ['hooks changed']
	const recorded: string[] = []
	const { owner, path } = await setup({
		check: async () => changes,
		record: async (folder) => {
			recorded.push(folder)
			changes = []
		},
	})
	const project = await owner.openProject(path)
	expect(project).toMatchObject({ trusted: false, settingsChanged: ['hooks changed'] })
	// Every guarded operation refuses while it is untrusted here, though the host says trusted.
	expect(await owner.listConversations(project.id)).toEqual([])
	await expect(owner.newConversation(project.id)).rejects.toThrow(/trust/i)
	const trusted = await owner.trust(project.id)
	expect(trusted.trusted).toBe(true)
	expect(trusted.settingsChanged).toBeUndefined()
	expect(recorded).toEqual([path])
})

it('leaves an unchanged folder trusted', async () => {
	const { owner, path } = await setup({ check: async () => [], record: async () => {} })
	expect(await owner.openProject(path)).toMatchObject({ trusted: true })
})

it('fails open, with a record, when the fingerprint cannot be read', async () => {
	const { owner, path } = await setup({
		check: async () => {
			throw new Error('disk')
		},
		record: async () => {},
	})
	expect(await owner.openProject(path)).toMatchObject({ trusted: true })
})

it('looks again before a new conversation: a change after connect untrusts the folder and refuses the work', async () => {
	let changes: string[] = []
	const { owner, path } = await setup({ check: async () => changes, record: async () => {} })
	const project = await owner.openProject(path)
	expect(project.trusted).toBe(true)
	changes = ['plugin a.js added']
	await expect(owner.newConversation(project.id)).rejects.toThrow(/automatic settings changed/)
	const after = owner.listProjects().find((item) => item.id === project.id)
	expect(after).toMatchObject({ trusted: false, settingsChanged: ['plugin a.js added'] })
	expect(await owner.listConversations(project.id)).toEqual([])
})

it('records every connected trusted project again when asked', async () => {
	const recorded: string[] = []
	const { owner, path } = await setup({
		check: async () => [],
		record: async (folder) => {
			recorded.push(folder)
		},
	})
	await owner.openProject(path)
	await owner.rebaselineTrusted()
	expect(recorded).toEqual([path])
})

it('looks again before a terminal: a change after connect refuses it and untrusts the folder', async () => {
	let changes: string[] = []
	const { owner, path } = await setup({ check: async () => changes, record: async () => {} })
	const project = await owner.openProject(path)
	await expect(owner.terminalHost(project.id)).resolves.toMatchObject({ project: { path } })
	changes = ['hooks changed']
	await expect(owner.terminalHost(project.id)).rejects.toThrow(/automatic settings changed/)
	expect(owner.listProjects().find((item) => item.id === project.id)).toMatchObject({
		trusted: false,
	})
})
