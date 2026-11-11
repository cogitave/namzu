import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView, DesktopEvent, PermissionView } from '../shared/protocol.js'
import { DesktopConversationStore } from './desktop-conversation-store.js'
import { Operator } from './operator.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function harness(directory?: string, env: NodeJS.ProcessEnv = {}) {
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const viewed = { ids: new Set<string>() }
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, ...env },
		},
		(event) => {
			recorded.push(event)
			events.emit('update', event)
		},
		directory,
		undefined,
		undefined,
		undefined,
		undefined,
		{ viewedConversations: () => viewed.ids },
	)
	owners.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (!predicate(event)) return
				events.off('update', receive)
				resolve(event)
			}
			events.on('update', receive)
		})
	const finishTurn = async (sessionId: string, prompt: string) => {
		const asked = wait(
			(event) => event.kind === 'permission' && event.request.sessionId === sessionId,
		)
		owner.send(sessionId, prompt)
		const request = ((await asked) as { request: PermissionView }).request
		const ended = wait(
			(event) => event.kind === 'state' && event.sessionId === sessionId && !event.running,
		)
		owner.respondPermission(sessionId, request.id, { outcome: 'approve' })
		await ended
	}
	const updates = (id: string) =>
		recorded.filter(
			(event): event is Extract<DesktopEvent, { kind: 'conversation-updated' }> =>
				event.kind === 'conversation-updated' && event.sessionId === id,
		)
	return { owner, finishTurn, updates, viewed }
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	title: id,
	updatedAt: '2026-11-01T00:00:00.000Z',
	...extra,
})

it('carries the log’s word that a conversation has a reply on its list entry', async () => {
	const { owner } = harness(undefined, {
		FIXTURE_LIST_ROWS: JSON.stringify([row('with-reply', { replied: true }), row('without')]),
	})
	const project = await owner.openProject(process.cwd())
	const listed = await owner.listConversations(project.id)
	expect(listed.find((item) => item.id === 'with-reply')?.replied).toBe(true)
	expect(listed.find((item) => item.id === 'without')?.replied).toBeUndefined()
	// Anything but the literal true is no claim.
	const loose = harness(undefined, {
		FIXTURE_LIST_ROWS: JSON.stringify([row('odd', { replied: 'yes' })]),
	})
	const other = await loose.owner.openProject(process.cwd())
	expect((await loose.owner.listConversations(other.id))[0]?.replied).toBeUndefined()
})

it('keeps the fact after a restart: the log answers again, and the saved list holds it too', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-replied-'))
	directories.push(root)
	const before = harness(root)
	const project = await before.owner.openProject(process.cwd())
	const a = await before.owner.newConversation(project.id)
	expect(a.replied).toBeUndefined()
	await before.finishTurn(a.id, 'Answer me')
	await before.owner.close()
	owners.splice(owners.indexOf(before.owner), 1)
	expect(
		new DesktopConversationStore(root).read()?.conversations.find((item) => item.view.id === a.id)
			?.view.replied,
	).toBe(true)
	const after = harness(root, {
		FIXTURE_LIST_ROWS: JSON.stringify([row(a.id, { replied: true })]),
	})
	const reopened = await after.owner.openProject(process.cwd())
	expect(
		(await after.owner.listConversations(reopened.id)).find((item) => item.id === a.id),
	).toMatchObject({
		replied: true,
	})
})

it('tells every window when a conversation gets its first reply while they look at others', async () => {
	const { owner, finishTurn, updates, viewed } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	viewed.ids = new Set([b.id])
	expect(updates(a.id)).toEqual([])
	await finishTurn(a.id, 'First reply')
	const heard = updates(a.id)
	expect(heard).toHaveLength(1)
	expect((heard[0]?.view as ConversationView).replied).toBe(true)
	// Said once, not on every later turn; the other conversation heard nothing.
	await finishTurn(a.id, 'Second reply')
	expect(updates(a.id)).toHaveLength(1)
	expect(updates(b.id)).toEqual([])
	// The next list keeps it even if the host's index has not caught up.
	const listed = await owner.listConversations(project.id)
	expect(listed.find((item) => item.id === a.id)?.replied).toBe(true)
	expect(listed.find((item) => item.id === b.id)?.replied).toBeUndefined()
})

it('gives a fork the reply its source had, and none to a source without one', async () => {
	const { owner } = harness(undefined, {
		FIXTURE_LIST_ROWS: JSON.stringify([row('replied-one', { replied: true }), row('bare')]),
	})
	const project = await owner.openProject(process.cwd())
	await owner.listConversations(project.id)
	expect((await owner.forkConversation('replied-one')).replied).toBe(true)
	expect((await owner.forkConversation('bare')).replied).toBeUndefined()
})
