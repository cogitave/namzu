import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'

const owners: Operator[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
})

type Call = ['needsYou', string[]] | ['started', string] | ['ended', string, string, boolean]

function harness() {
	const events = new EventEmitter()
	const calls: Call[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		(event) => events.emit('update', event),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			notices: {
				needsYou: (ids) => calls.push(['needsYou', ids]),
				turnStarted: (id) => calls.push(['started', id]),
				turnEnded: (id, outcome, pal) => calls.push(['ended', id, outcome, pal]),
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
	return { owner, calls, wait }
}

it('reports a turn starting and a normal end as finished', async () => {
	const h = harness()
	const project = await h.owner.openProject(process.cwd())
	const a = await h.owner.newConversation(project.id)
	const asked = h.wait((e) => e.kind === 'permission' && e.request.sessionId === a.id)
	h.owner.send(a.id, 'Needs approval')
	const request = ((await asked) as { request: { id: string } }).request
	const ended = h.wait((e) => e.kind === 'state' && e.sessionId === a.id && !e.running)
	h.owner.respondPermission(a.id, request.id, { outcome: 'approve' })
	await ended
	expect(h.calls.filter((call) => call[0] !== 'needsYou')).toEqual([
		['started', a.id],
		['ended', a.id, 'finished', false],
	])
})

it('reports a turn that stopped with an error as failed, and a Pal turn as a Pal turn', async () => {
	const h = harness()
	const project = await h.owner.openProject(process.cwd())
	const a = await h.owner.newConversation(project.id)
	const session = (
		h.owner as unknown as { conversations: Map<string, { view: { palId?: string } }> }
	).conversations.get(a.id)
	if (!session) throw new Error('missing conversation')
	session.view.palId = 'pal'
	const ended = h.wait((e) => e.kind === 'state' && e.sessionId === a.id && !e.running)
	h.owner.send(a.id, 'Fail turn with fixture')
	await ended
	expect(h.calls.filter((call) => call[0] === 'ended')).toEqual([['ended', a.id, 'failed', true]])
})

it('reports a waiting conversation to the notices, a Pal included', async () => {
	const h = harness()
	const project = await h.owner.openProject(process.cwd())
	const a = await h.owner.newConversation(project.id)
	const session = (
		h.owner as unknown as { conversations: Map<string, { view: { palId?: string } }> }
	).conversations.get(a.id)
	if (!session) throw new Error('missing conversation')
	session.view.palId = 'pal'
	const asked = h.wait((e) => e.kind === 'permission' && e.request.sessionId === a.id)
	h.owner.send(a.id, 'Needs approval')
	await asked
	expect(h.calls.filter((call) => call[0] === 'needsYou').at(-1)).toEqual(['needsYou', [a.id]])
	expect(h.owner.needsYou()).toEqual([])
	expect(h.owner.projectNameOf(a.id)).toBe(project.name)
})
