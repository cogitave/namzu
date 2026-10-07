import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import {
	DesktopConversationStore,
	parseDesktopConversationSnapshot,
} from './desktop-conversation-store.js'
import { Operator } from './operator.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup(env: NodeJS.ProcessEnv = {}) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-actions-'))
	directories.push(root)
	const log = join(root, 'requests.ndjson')
	const events: DesktopEvent[] = []
	const store = new DesktopConversationStore(root)
	store.write({
		version: 1,
		projects: [{ id: 'project', path: process.cwd() }],
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
				draftSettings: { options: { effort: 'high' } },
				providerSelection: { provider: 'fixture', model: 'model' },
			},
		],
		projectDrafts: [],
		attachments: [],
	})
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_REQUEST_LOG: log, ...env },
		},
		(event) => events.push(event),
		root,
	)
	owners.push(owner)
	const project = await owner.openProject(process.cwd())
	const requests = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map(
				(line) =>
					JSON.parse(line) as {
						method: string
						params?: Record<string, unknown>
					},
			)
	return { owner, project, events, root, requests }
}

it('renames through the host, updates the catalogue and the saved store, and emits the new view', async () => {
	const { owner, project, events, root, requests } = await setup()
	await owner.listConversations(project.id)
	const view = await owner.renameConversation('saved', '  Release plan  ')
	expect(view).toMatchObject({ id: 'saved', title: 'Release plan' })
	expect(
		(await requests()).find((call) => call.method === 'namzu/conversations/rename')?.params,
	).toEqual({ sessionId: 'runtime-saved', title: 'Release plan' })
	expect(events).toContainEqual(
		expect.objectContaining({
			kind: 'conversation-updated',
			sessionId: 'saved',
			view,
		}),
	)
	expect(
		new DesktopConversationStore(root)
			.read()
			?.conversations.find((item) => item.view.id === 'saved')?.view.title,
	).toBe('Release plan')
	// An empty title asks the host to restore the derived one.
	expect((await owner.renameConversation('saved', '   ')).title).toBe('Derived title')
	await expect(owner.renameConversation('saved', 'x'.repeat(201))).rejects.toThrow('200')
	await expect(owner.renameConversation('missing', 'x')).rejects.toThrow()
})

it('pins and unpins desktop-locally, persists the flag and keeps it in the listing', async () => {
	const { owner, project, events, root, requests } = await setup()
	const pinned = await owner.setConversationPinned('saved', true)
	expect(pinned.pinned).toBe(true)
	expect(events).toContainEqual(
		expect.objectContaining({
			kind: 'conversation-updated',
			sessionId: 'saved',
			view: pinned,
		}),
	)
	expect(
		new DesktopConversationStore(root).read()?.conversations.find((i) => i.view.id === 'saved')
			?.view.pinned,
	).toBe(true)
	expect((await requests()).some((call) => call.method.includes('rename'))).toBe(false)
	await owner.listConversations(project.id)
	const unpinned = await owner.setConversationPinned('saved', false)
	expect('pinned' in unpinned).toBe(false)
	expect(
		new DesktopConversationStore(root).read()?.conversations.find((i) => i.view.id === 'saved')
			?.view,
	).not.toHaveProperty('pinned')
	await expect(owner.setConversationPinned('saved', 'yes' as never)).rejects.toThrow('Invalid')
})

it('forks into a new registered conversation that carries the draft settings and model choice', async () => {
	const { owner, project, requests } = await setup()
	const fork = await owner.forkConversation('saved')
	expect(fork).toMatchObject({
		projectId: project.id,
		title: 'Forked conversation (fork)',
	})
	expect(fork.id).toMatch(/^fork-/)
	expect(
		(await requests()).find((call) => call.method === 'namzu/conversations/fork')?.params,
	).toEqual({ sessionId: 'runtime-saved' })
	expect(owner.draftSettings(fork.id)).toMatchObject({
		options: { effort: 'high' },
	})
	expect((await owner.openConversation(project.id, fork.id)).messages).toEqual([])
	await expect(owner.forkConversation('saved')).resolves.toMatchObject({
		projectId: project.id,
	})
})

it('refuses to fork a conversation that was never prompted', async () => {
	const { owner, project } = await setup()
	const fresh = await owner.newConversation(project.id)
	await expect(owner.forkConversation(fresh.id)).rejects.toThrow('Send a message')
})

it('refuses rename, fork and export for external engines', async () => {
	const { owner } = await setup()
	await owner.selectHarness('saved', 'codex-cli')
	await expect(owner.renameConversation('saved', 'x')).rejects.toThrow('cannot be renamed')
	await expect(owner.forkConversation('saved')).rejects.toThrow('cannot be forked')
	await expect(owner.conversationMarkdown('saved')).rejects.toThrow('cannot be exported')
	// Pinning is desktop-local, so every ordinary engine can do it.
	await expect(owner.setConversationPinned('saved', true)).resolves.toMatchObject({ pinned: true })
})

it('passes the Markdown export and the repository facts through after validation', async () => {
	const { owner, project, requests } = await setup()
	expect(await owner.conversationMarkdown('saved')).toEqual({
		markdown: '# Exported',
		truncated: false,
	})
	expect(
		(await requests()).find((call) => call.method === 'namzu/conversations/markdown')?.params,
	).toEqual({ sessionId: 'runtime-saved' })
	expect(await owner.projectGit(project.id)).toEqual({
		branch: 'main',
		subject: 'Initial commit',
	})
	await expect(owner.projectGit('unknown')).rejects.toThrow()
})

it('answers null when the host reports no repository', async () => {
	const { owner, project } = await setup({ FIXTURE_NO_GIT: '1' })
	expect(await owner.projectGit(project.id)).toBeNull()
})

it('passes working-tree changes and one diff through, naming the path the host was asked for', async () => {
	const { owner, project, requests } = await setup()
	expect(await owner.projectChanges(project.id)).toEqual({
		files: [{ path: 'a.ts', status: 'modified', added: 2, removed: 1 }],
		truncated: false,
	})
	expect(await owner.projectDiff(project.id, 'a.ts')).toEqual({
		before: 'old\n',
		after: 'new\n',
		binary: false,
		truncated: false,
	})
	expect((await requests()).find((call) => call.method === 'namzu/project/diff')?.params).toEqual({
		path: 'a.ts',
	})
	await expect(owner.projectChanges('unknown')).rejects.toThrow()
	await expect(owner.projectDiff(project.id, '')).rejects.toThrow('not inside')
	await expect(owner.projectDiff(project.id, 5 as never)).rejects.toThrow('not inside')
})

it('answers null for a non-repository and refuses a host that cannot show changes', async () => {
	const none = await setup({ FIXTURE_CHANGES: 'null' })
	expect(await none.owner.projectChanges(none.project.id)).toBeNull()
	const old = await setup({ FIXTURE_NO_CHANGES: '1' })
	expect(await old.owner.projectChanges(old.project.id)).toBeNull()
	await expect(old.owner.projectDiff(old.project.id, 'a.ts')).rejects.toThrow('Update Namzu')
})

it('rejects a malformed answer from the host instead of passing it on', async () => {
	const badFiles = [
		{
			files: [{ path: 'a.ts', status: 'weird', added: 0, removed: 0 }],
			truncated: false,
		},
		{
			files: [{ path: 'a\u0000b', status: 'added', added: 0, removed: 0 }],
			truncated: false,
		},
		{
			files: [{ path: 'a.ts', status: 'added', added: -1, removed: 0 }],
			truncated: false,
		},
		{
			files: [{ path: 'a.ts', status: 'added', added: 1, removed: 0, oldPath: 7 }],
			truncated: false,
		},
		{ files: [], truncated: 'no' },
		{ files: 'x', truncated: false },
	]
	for (const reply of badFiles) {
		const { owner, project } = await setup({
			FIXTURE_CHANGES: JSON.stringify(reply),
		})
		await expect(owner.projectChanges(project.id)).rejects.toThrow('invalid')
	}
	const bad = await setup({
		FIXTURE_DIFF: JSON.stringify({
			before: 1,
			after: null,
			binary: false,
			truncated: false,
		}),
	})
	await expect(bad.owner.projectDiff(bad.project.id, 'a.ts')).rejects.toThrow('invalid')
})

it('keeps a saved pin through the strict validator and rejects a malformed one', () => {
	const base = {
		version: 1,
		projects: [{ id: 'p', path: '/p' }],
		conversations: [
			{
				view: {
					id: 's',
					projectId: 'p',
					title: 'T',
					updatedAt: '2026-10-04T00:00:00.000Z',
					pinned: true,
				},
				runtimeSessionId: 'r',
				hasPrompted: false,
				draft: '',
			},
		],
		projectDrafts: [],
		attachments: [],
	}
	expect(parseDesktopConversationSnapshot(base)?.conversations[0]?.view.pinned).toBe(true)
	const bad = structuredClone(base)
	;(bad.conversations[0]?.view as Record<string, unknown>).pinned = false
	expect(parseDesktopConversationSnapshot(bad)).toBeNull()
})

it('renames and pins a catalogue-only conversation by adopting it, and the pin survives a relist', async () => {
	const rows = [
		{
			id: 'sidebar',
			title: 'Sidebar only',
			updatedAt: '2026-10-05T00:00:00.000Z',
		},
	]
	const { owner, project, root, requests } = await setup({
		FIXTURE_LIST_ROWS: JSON.stringify(rows),
	})
	await owner.listConversations(project.id)
	const renamed = await owner.renameConversation('sidebar', 'Renamed from sidebar')
	expect(renamed).toMatchObject({
		id: 'sidebar',
		title: 'Renamed from sidebar',
	})
	expect(
		(await requests()).find((call) => call.method === 'namzu/conversations/rename')?.params,
	).toEqual({ sessionId: 'sidebar', title: 'Renamed from sidebar' })
	const pinned = await owner.setConversationPinned('sidebar', true)
	expect(pinned.pinned).toBe(true)
	const listed = await owner.listConversations(project.id)
	expect(listed.find((row) => row.id === 'sidebar')?.pinned).toBe(true)
	expect(
		new DesktopConversationStore(root).read()?.conversations.find((i) => i.view.id === 'sidebar')
			?.view,
	).toMatchObject({ title: 'Renamed from sidebar', pinned: true })
})

it('lists archived conversations and restores one into the catalogue, store and events', async () => {
	const archived = [{ id: 'old', title: 'Old chat', updatedAt: '2026-10-01T00:00:00.000Z' }]
	const { owner, project, events, root, requests } = await setup({
		FIXTURE_ARCHIVED_ROWS: JSON.stringify(archived),
	})
	const listed = await owner.archivedConversations(project.id)
	expect(listed).toEqual([{ ...archived[0], projectId: project.id }])
	await expect(owner.restoreConversation('never-listed')).rejects.toThrow('archived list')
	const restored = await owner.restoreConversation('old')
	expect(restored).toMatchObject({
		id: 'old',
		title: 'Restored title',
		projectId: project.id,
	})
	expect(
		(await requests()).find((call) => call.method === 'namzu/conversations/unarchive')?.params,
	).toEqual({ sessionId: 'old' })
	expect(events).toContainEqual(
		expect.objectContaining({
			kind: 'conversation-updated',
			sessionId: 'old',
			view: restored,
		}),
	)
	expect(
		new DesktopConversationStore(root).read()?.conversations.find((i) => i.view.id === 'old')?.view
			.title,
	).toBe('Restored title')
	// Restoring twice needs a fresh listing.
	await expect(owner.restoreConversation('old')).rejects.toThrow('archived list')
})

it('refuses an invalid archived row from the host', async () => {
	const { owner, project } = await setup({
		FIXTURE_ARCHIVED_ROWS: JSON.stringify([{ id: 'x', title: 3 }]),
	})
	await expect(owner.archivedConversations(project.id)).rejects.toThrow('invalid')
})
