import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

const folder = async () => {
	const path = await mkdtemp(join(tmpdir(), 'namzu-removal-folder-'))
	directories.push(path)
	return path
}

async function setup(env: NodeJS.ProcessEnv = {}, extraSaved = true) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-project-removal-'))
	directories.push(root)
	const path = await folder()
	const log = join(root, 'requests.ndjson')
	const events: DesktopEvent[] = []
	const bus = new EventEmitter()
	if (extraSaved) {
		new DesktopConversationStore(root).write({
			version: 1,
			projects: [{ id: 'project', path }],
			conversations: [
				{
					view: {
						id: 'saved',
						projectId: 'project',
						title: 'Saved title',
						updatedAt: '2026-10-04T00:00:00.000Z',
						pinned: true,
					},
					runtimeSessionId: 'runtime-saved',
					hasPrompted: true,
					draft: 'half a thought',
				},
			],
			projectDrafts: [{ ownerId: 'project:project', draft: 'project draft' }],
			attachments: [],
		})
	}
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_REQUEST_LOG: log, ...env },
		},
		(event) => {
			events.push(event)
			bus.emit('event', event)
		},
		root,
	)
	owners.push(owner)
	const project = await owner.openProject(path)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					bus.off('event', receive)
					resolve(event)
				}
			}
			bus.on('event', receive)
		})
	const requests = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
	return { owner, project, path, root, events, wait, requests }
}

it('removes the project everywhere, untrusts only its folder, and keeps files and journals', async () => {
	const { owner, project, path, root, events, requests } = await setup()
	expect(project.id).toBe('project')
	const result = await owner.removeProject(project.id)
	expect(result).toEqual({
		projectId: 'project',
		sessionIds: ['saved'],
		trust: { state: 'removed' },
	})
	expect(
		(await requests()).find((call) => call.method === 'namzu/project/untrust')?.params,
	).toEqual({ cwd: path, confirmed: true })
	// No journal is touched: nothing is archived or deleted on the host.
	expect((await requests()).some((call) => call.method.includes('archive'))).toBe(false)
	expect(owner.listProjects()).toEqual([])
	expect(events).toContainEqual(
		expect.objectContaining({
			kind: 'project-removed',
			projectId: 'project',
			sessionIds: ['saved'],
		}),
	)
	// A removed project is not reported as a failed connection.
	expect(
		events.some((event) => event.kind === 'connection' && event.project.status === 'error'),
	).toBe(false)
	const saved = new DesktopConversationStore(root).read()
	expect(saved?.projects).toEqual([])
	expect(saved?.conversations).toEqual([])
	expect(saved?.projectDrafts).toEqual([])
	expect(owner.restoredProjectPaths(['saved'])).toEqual([])
	await expect(owner.listConversations('project')).rejects.toThrow()
	await expect(owner.removeProject('project')).rejects.toThrow('no longer in Namzu')
})

it('lists the conversations again when the same folder is added back, under a new project id', async () => {
	const rows = [{ id: 'on-disk', title: 'Journal survives', updatedAt: '2026-10-05T00:00:00.000Z' }]
	const { owner, project, path } = await setup({ FIXTURE_LIST_ROWS: JSON.stringify(rows) })
	await owner.listConversations(project.id)
	await owner.removeProject(project.id)
	const again = await owner.openProject(path)
	expect(again.id).not.toBe(project.id)
	expect(again.trusted).toBe(true)
	expect(await owner.listConversations(again.id)).toEqual([
		expect.objectContaining({ id: 'on-disk', projectId: again.id }),
	])
	// Pins and drafts lived only in Namzu's own state, so they do not come back.
	const relisted = await owner.listConversations(again.id)
	expect(relisted.some((row) => row.id === 'saved' || row.pinned)).toBe(false)
})

it('refuses while a reply is running, says so, and removes once it stops', async () => {
	const { owner, project, wait } = await setup({}, false)
	const conversation = await owner.newConversation(project.id)
	const review = wait((event) => event.kind === 'permission')
	owner.send(conversation.id, 'Keep working')
	await review
	await expect(owner.removeProject(project.id)).rejects.toThrow(/reply is still running/)
	expect(owner.listProjects()).toHaveLength(1)
	expect(owner.listProjects()[0]?.status).toBe('ready')
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === conversation.id && !event.running,
	)
	await owner.cancel(conversation.id)
	await stopped
	const result = await owner.removeProject(project.id)
	expect(result.sessionIds).toEqual([conversation.id])
	expect(owner.listProjects()).toEqual([])
})

it('refuses the chat workspace and invalid ids', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-project-removal-chat-'))
	directories.push(root)
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		() => {},
		root,
	)
	owners.push(owner)
	const chat = await owner.openChat()
	await expect(owner.removeProject(chat.id)).rejects.toThrow('chat workspace')
	await expect(owner.removeProject(42)).rejects.toThrow('Invalid project')
	await expect(owner.removeProject('')).rejects.toThrow('Invalid project')
	expect(owner.listProjects()).toHaveLength(1)
})

it('reports a parent folder that keeps the project trusted instead of claiming it was untrusted', async () => {
	const parent = await folder()
	const { owner, project } = await setup({ FIXTURE_STILL_TRUSTED_BY: parent })
	const result = await owner.removeProject(project.id)
	expect(result.trust).toEqual({ state: 'still-trusted', by: parent })
})

it('removes a project whose runtime predates untrust and says the folder stays trusted', async () => {
	const { owner, project, requests } = await setup({ FIXTURE_NO_UNTRUST: '1' })
	const result = await owner.removeProject(project.id)
	expect(result.trust).toEqual({ state: 'unsupported' })
	expect((await requests()).some((call) => call.method === 'namzu/project/untrust')).toBe(false)
	expect(owner.listProjects()).toEqual([])
})

it('removes nothing when the trust list cannot be updated, so it can be tried again', async () => {
	const { owner, project } = await setup({ FIXTURE_UNTRUST_FAILS: '1' })
	await expect(owner.removeProject(project.id)).rejects.toThrow('nothing was removed')
	expect(owner.listProjects()).toHaveLength(1)
	expect(owner.listProjects()[0]?.status).toBe('ready')
})

it('keeps the other projects intact', async () => {
	const { owner, project, root } = await setup({}, false)
	const other = await owner.openProject(await folder())
	const kept = await owner.newConversation(other.id)
	await owner.removeProject(project.id)
	expect(owner.listProjects().map((item) => item.id)).toEqual([other.id])
	expect((await owner.newConversation(other.id)).projectId).toBe(other.id)
	expect(
		new DesktopConversationStore(root).read()?.conversations.map((item) => item.view.id),
	).toContain(kept.id)
})
