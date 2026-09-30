import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'
const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
})
function harness() {
	const events = new EventEmitter()
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		(event) => events.emit('update', event),
	)
	operators.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					events.off('update', receive)
					resolve(event)
				}
			}
			events.on('update', receive)
		})
	const permission = async (): Promise<PermissionView> => {
		const event = await wait((event) => event.kind === 'permission')
		if (event.kind !== 'permission') throw new Error('Missing review')
		return event.request
	}
	return { owner, permission, wait }
}
it('keeps review ownership, queued text and the live projection across UI reattachment', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	const first = permission()
	owner.send(a.id, 'First request')
	const review = await first
	owner.send(a.id, 'Queued request')
	const restored = await owner.openConversation(project.id, a.id)
	expect(restored.thread).toMatchObject({
		running: true,
		queued: ['Queued request'],
		permissions: [{ id: review.id }],
		messages: [{ role: 'user', text: 'First request' }],
	})
	expect(() => owner.approve(b.id, review.id, true)).toThrow('no longer pending')
	const next = permission()
	owner.approve(a.id, review.id, true)
	const nextReview = await next
	expect(nextReview.id).not.toBe(review.id)
	const ended = wait(
		(event) => event.kind === 'state' && event.sessionId === a.id && !event.running,
	)
	owner.approve(a.id, nextReview.id, false)
	await ended
	expect((await owner.openConversation(project.id, a.id)).thread).toMatchObject({
		running: false,
		queued: [],
		permissions: [],
		messages: [
			{ role: 'user', text: 'First request' },
			{ role: 'assistant', text: 'Approved answer' },
			{ role: 'user', text: 'Queued request' },
			{ role: 'assistant', text: 'Declined answer' },
		],
	})
	expect(() => owner.approve(a.id, review.id, true)).toThrow('no longer pending')
})
it('cancels pending permission without discarding an authored queue', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const first = permission()
	owner.send(a.id, 'First request')
	await first
	owner.send(a.id, 'Retain me')
	const stopped = wait(
		(event) => event.kind === 'state' && event.sessionId === a.id && !event.running,
	)
	await owner.cancel(a.id)
	await stopped
	expect((await owner.openConversation(project.id, a.id)).thread).toMatchObject({
		running: false,
		permissions: [],
		queued: ['Retain me'],
	})
	expect(owner.takeQueued(a.id)).toBe('Retain me')
})

it('reconnects the same project and reattaches its conversation without replaying a failed prompt', async () => {
	const { owner, permission, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const failed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(a.id, 'Break connection')
	await failed
	expect(await owner.reconnect(project.id)).toMatchObject({ id: project.id, status: 'ready' })
	const history = await owner.openConversation(project.id, a.id)
	expect(history.thread).toMatchObject({
		running: false,
		messages: [{ role: 'user', text: 'Break connection' }],
		permissions: [],
	})
	const review = permission()
	owner.send(a.id, 'Explicit retry')
	const request = await review
	expect(request.calls[0]?.input).toEqual({ prompt: 'Explicit retry' })
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.approve(a.id, request.id, true)
	await ended
})
