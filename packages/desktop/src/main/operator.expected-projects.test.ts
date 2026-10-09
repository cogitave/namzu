import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { DesktopConversationStore } from './desktop-conversation-store.js'
import { Operator } from './operator.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-expected-'))
	const path = await mkdtemp(join(tmpdir(), 'namzu-expected-folder-'))
	const palPath = await mkdtemp(join(tmpdir(), 'namzu-expected-pal-'))
	directories.push(root, path, palPath)
	new DesktopConversationStore(root).write({
		version: 1,
		projects: [
			{ id: 'project', path },
			{ id: 'pal-project', path: palPath },
		],
		conversations: [
			{
				view: {
					id: 'saved',
					projectId: 'project',
					title: 'Saved title',
					updatedAt: '2026-10-04T00:00:00.000Z',
				},
				runtimeSessionId: 'runtime-saved',
				hasPrompted: true,
				draft: '',
			},
			{
				view: {
					id: 'pal-saved',
					projectId: 'pal-project',
					title: 'Pal talk',
					updatedAt: '2026-10-04T00:00:00.000Z',
					palId: 'pal-1',
				},
				runtimeSessionId: 'runtime-pal',
				hasPrompted: true,
				draft: '',
			},
		],
		projectDrafts: [],
		attachments: [],
	})
	const events: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env },
		},
		(event) => events.push(event),
		root,
	)
	owners.push(owner)
	return { owner, path, palPath, events }
}

it('lists a folder that is waiting to reopen as connecting, with the id it will connect under', async () => {
	const { owner, path, palPath } = await setup()
	expect(owner.projectsForWindow()).toEqual([])
	owner.expectProjects([path, palPath, '/never/saved'])
	const listed = owner.projectsForWindow()
	expect(listed.map((item) => [item.id, item.status])).toEqual([
		['project', 'connecting'],
		['pal-project', 'connecting'],
	])
	expect(listed[1]?.palId).toBe('pal-1')
	// The real connection replaces the placeholder, never duplicates it.
	await owner.openProject(path)
	expect(owner.projectsForWindow().filter((item) => item.path === path)).toHaveLength(1)
	expect(owner.projectsForWindow().find((item) => item.path === path)?.status).toBe('ready')
	// listProjects (what projects.json is written from) never carries a placeholder.
	expect(owner.listProjects().map((item) => item.path)).toEqual([path])
})

it('reports a folder that never connected as failed instead of leaving it connecting', async () => {
	const { owner, path, events } = await setup()
	owner.expectProjects([path])
	owner.settleExpectedProject(path)
	expect(events).toContainEqual(
		expect.objectContaining({
			kind: 'connection',
			project: expect.objectContaining({ id: 'project', status: 'error' }),
		}),
	)
	expect(owner.projectsForWindow()).toEqual([])
})

it('answers the saved views of the open tabs only', async () => {
	const { owner } = await setup()
	expect(owner.savedConversationViews(['saved', 'unknown']).map((item) => item.id)).toEqual([
		'saved',
	])
})

it('keeps a project whose folder is gone, marked as missing, instead of dropping it', async () => {
	const { owner, path, events } = await setup()
	await rm(path, { recursive: true, force: true })
	owner.expectProjects([path])
	owner.settleExpectedProject(path)
	const [listed] = owner.projectsForWindow()
	expect(listed).toMatchObject({
		id: 'project',
		path,
		status: 'error',
		error: 'Folder not found',
		missing: true,
	})
	expect(events).toContainEqual(
		expect.objectContaining({
			kind: 'connection',
			project: expect.objectContaining({ id: 'project', missing: true }),
		}),
	)
	// It is not a connection: projects.json must be told separately to keep it.
	expect(owner.listProjects()).toEqual([])
	expect(owner.missingProjectPaths()).toEqual([path])
})

it('gives a located folder the missing project\u2019s id, so its conversations come along', async () => {
	const { owner, path } = await setup()
	const moved = await mkdtemp(join(tmpdir(), 'namzu-expected-moved-'))
	directories.push(moved)
	await rm(path, { recursive: true, force: true })
	owner.expectProjects([path])
	owner.settleExpectedProject(path)
	owner.expectRelocation(moved, 'project')
	const opened = await owner.openProject(moved)
	expect(opened.id).toBe('project')
	expect(opened.missing).toBeUndefined()
	// The row is now the connection, not the missing placeholder.
	expect(owner.projectsForWindow().filter((item) => item.id === 'project')).toHaveLength(1)
	expect(owner.missingProjectPaths()).toEqual([])
})

it('ignores a relocation for a project that is not missing', async () => {
	const { owner, path } = await setup()
	const other = await mkdtemp(join(tmpdir(), 'namzu-expected-other-'))
	directories.push(other)
	owner.expectRelocation(other, 'project')
	expect((await owner.openProject(other)).id).not.toBe('project')
	expect(path).toBeTruthy()
})

it('removes a missing project without a connection, forgetting its saved conversations', async () => {
	const { owner, path, events } = await setup()
	await rm(path, { recursive: true, force: true })
	owner.expectProjects([path])
	owner.settleExpectedProject(path)
	const result = await owner.removeProject('project')
	expect(result).toMatchObject({
		projectId: 'project',
		sessionIds: ['saved'],
		trust: { state: 'not-connected' },
	})
	expect(owner.projectsForWindow()).toEqual([])
	expect(owner.savedConversationViews(['saved'])).toEqual([])
	expect(events).toContainEqual(expect.objectContaining({ kind: 'project-removed' }))
})
