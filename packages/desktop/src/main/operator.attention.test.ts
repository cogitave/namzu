import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'

const owners: Operator[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
})

function harness(env?: NodeJS.ProcessEnv) {
	const events = new EventEmitter()
	const reported: string[][] = []
	const kinds: { permission: string[]; question: string[] }[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			...(env ? { env: { ...process.env, ...env } } : {}),
		},
		(event) => events.emit('update', event),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			attentionChanged: (ids, byKind) => {
				reported.push(ids)
				kinds.push(byKind)
			},
		},
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
	return { owner, reported, kinds, wait }
}

async function askPermission(h: ReturnType<typeof harness>, sessionId: string) {
	const asked = h.wait((e) => e.kind === 'permission' && e.request.sessionId === sessionId)
	h.owner.send(sessionId, 'Needs approval')
	return ((await asked) as { request: PermissionView }).request
}

it('reports a conversation when a permission arrives and lets go when it clears', async () => {
	const h = harness()
	const project = await h.owner.openProject(process.cwd())
	const a = await h.owner.newConversation(project.id)
	const request = await askPermission(h, a.id)
	expect(h.owner.needsYou()).toEqual([a.id])
	expect(h.reported.at(-1)).toEqual([a.id])
	const ended = h.wait((e) => e.kind === 'state' && e.sessionId === a.id && !e.running)
	h.owner.respondPermission(a.id, request.id, { outcome: 'approve' })
	await ended
	expect(h.owner.needsYou()).toEqual([])
	expect(h.reported.at(-1)).toEqual([])
})

it('does not count a Pal conversation', async () => {
	const h = harness()
	const project = await h.owner.openProject(process.cwd())
	const a = await h.owner.newConversation(project.id)
	await askPermission(h, a.id)
	const session = (
		h.owner as unknown as { conversations: Map<string, { view: { palId?: string } }> }
	).conversations.get(a.id)
	if (!session) throw new Error('missing conversation')
	session.view.palId = 'pal'
	expect(h.owner.needsYou()).toEqual([])
})

it('does not count a stopped turn that still holds a permission, as the sidebar does not', async () => {
	const h = harness()
	const project = await h.owner.openProject(process.cwd())
	const a = await h.owner.newConversation(project.id)
	await askPermission(h, a.id)
	const session = (
		h.owner as unknown as {
			conversations: Map<string, { projection: { stopReason?: string } }>
		}
	).conversations.get(a.id)
	if (!session) throw new Error('missing conversation')
	session.projection.stopReason = 'cancelled'
	expect(h.owner.needsYou()).toEqual([])
})

it('reports once after a deletion, with the conversation that still waits', async () => {
	const h = harness()
	const project = await h.owner.openProject(process.cwd())
	const idle = await h.owner.newConversation(project.id)
	const waiting = await h.owner.newConversation(project.id)
	await askPermission(h, waiting.id)
	h.reported.length = 0
	await h.owner.removeConversation(idle.id)
	expect(h.reported).toEqual([[waiting.id]])
})

it('reports an approval as a permission and a question as a question', async () => {
	const permission = harness()
	const project = await permission.owner.openProject(process.cwd())
	const a = await permission.owner.newConversation(project.id)
	await askPermission(permission, a.id)
	expect(permission.kinds.at(-1)).toEqual({ permission: [a.id], question: [] })

	const question = harness({
		FIXTURE_COMPUTER_CALLS: JSON.stringify([{ name: 'ask_user_question' }]),
	})
	const other = await question.owner.openProject(process.cwd())
	const b = await question.owner.newConversation(other.id)
	await askPermission(question, b.id)
	expect(question.reported.at(-1)).toEqual([b.id])
	expect(question.kinds.at(-1)).toEqual({ permission: [], question: [b.id] })
})
