import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'
import { readUnreadFile } from './unread-file.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
function harness(directory?: string) {
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const viewed = { ids: new Set<string>() }
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
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
	/** Sends one prompt, approves the request it raises and resolves once the turn has ended. */
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
	const unreadEvents = () =>
		recorded.filter(
			(event): event is Extract<DesktopEvent, { kind: 'unread' }> => event.kind === 'unread',
		)
	return { owner, finishTurn, unreadEvents, viewed }
}

it('marks a turn that ends in a conversation no window shows, and announces it', async () => {
	const { owner, finishTurn, unreadEvents, viewed } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	viewed.ids = new Set([b.id])
	await finishTurn(a.id, 'Finish while away')
	expect(owner.conversationUnread()).toEqual({ ids: [a.id], sequence: 1 })
	expect(unreadEvents()).toEqual([{ kind: 'unread', ids: [a.id], sequence: 1 }])
})

it('leaves no marker when the turn ends in a conversation a window is showing', async () => {
	const { owner, finishTurn, unreadEvents, viewed } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	viewed.ids = new Set([a.id])
	await finishTurn(a.id, 'Finish in view')
	expect(owner.conversationUnread()).toEqual({ ids: [], sequence: 0 })
	expect(unreadEvents()).toEqual([])
})

it('reads a marker once when the conversation comes on screen, however often it is asked', async () => {
	const { owner, finishTurn, unreadEvents, viewed } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	await finishTurn(a.id, 'Finish while away')
	viewed.ids = new Set([a.id])
	owner.reconcileViewedConversations()
	owner.reconcileViewedConversations()
	expect(owner.conversationUnread().ids).toEqual([])
	expect(unreadEvents().map((event) => event.ids)).toEqual([[a.id], []])
	expect(unreadEvents().map((event) => event.sequence)).toEqual([1, 2])
})

it('lets the menu mark a conversation unread or read, and refuses one that is not open', async () => {
	const { owner, unreadEvents } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	expect(owner.setConversationUnread(a.id, true)).toEqual({ ids: [a.id], sequence: 1 })
	expect(owner.setConversationUnread(a.id, true)).toEqual({ ids: [a.id], sequence: 1 })
	expect(owner.setConversationUnread(a.id, false)).toEqual({ ids: [], sequence: 2 })
	expect(unreadEvents()).toHaveLength(2)
	expect(() => owner.setConversationUnread('nope', true)).toThrow('not open')
	expect(() => owner.setConversationUnread(a.id, 'yes')).toThrow('Invalid conversation')
})

it('keeps the marker across a restart', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-unread-'))
	directories.push(root)
	const before = harness(root)
	const project = await before.owner.openProject(process.cwd())
	const a = await before.owner.newConversation(project.id)
	await before.finishTurn(a.id, 'Finish while away')
	await before.owner.close()
	owners.splice(owners.indexOf(before.owner), 1)
	const after = harness(root)
	expect(after.owner.conversationUnread().ids).toEqual([a.id])
})

it('forgets the marker of a conversation that was archived, and saves that', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-unread-'))
	directories.push(root)
	const { owner, unreadEvents } = harness(root)
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	owner.setConversationUnread(a.id, true)
	expect(readUnreadFile(root)).toEqual([a.id])
	owner.setConversationUnread(a.id, false)
	expect(readUnreadFile(root)).toEqual([])
	expect(unreadEvents()).toHaveLength(2)
})
