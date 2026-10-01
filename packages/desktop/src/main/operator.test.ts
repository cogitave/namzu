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
	expect(await owner.reconnect(project.id)).toMatchObject({
		id: project.id,
		status: 'ready',
	})
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

it('retains separate authored drafts on reattachment and refuses invalid draft writes', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	owner.saveDraft(a.id, 'Unsent in first conversation')
	owner.saveDraft(b.id, 'Unsent in second conversation')
	await owner.openConversation(project.id, b.id)
	await owner.openConversation(project.id, a.id)
	expect(owner.draft(a.id)).toBe('Unsent in first conversation')
	expect(owner.draft(b.id)).toBe('Unsent in second conversation')
	expect(() => owner.saveDraft('foreign-session', 'Cannot attach')).toThrow(
		'Open this conversation',
	)
	expect(() => owner.saveDraft(a.id, 'x'.repeat(50_001))).toThrow('50,000')
	expect(owner.draft(a.id)).toBe('Unsent in first conversation')
})

it('keeps drafts available during connection failure and restores them after reconnect', async () => {
	const { owner, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	owner.saveDraft(session.id, 'Do not discard on disconnect')
	const failed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(session.id, 'Break connection')
	await failed
	expect(owner.draft(session.id)).toBe('Do not discard on disconnect')
	owner.saveDraft(session.id, 'Can keep writing while disconnected')
	expect(await owner.listConversations(project.id)).toContainEqual(
		expect.objectContaining({ id: session.id }),
	)
	expect((await owner.openConversation(project.id, session.id)).messages).toEqual([
		{ role: 'user', text: 'Break connection' },
	])
	expect(await owner.providers(project.id, session.id)).toEqual({
		available: [],
		selected: null,
	})
	expect(() => owner.send(session.id, 'Do not pretend this connected')).toThrow(
		'Reopen this project',
	)
	await owner.reconnect(project.id)
	await owner.openConversation(project.id, session.id)
	expect(owner.draft(session.id)).toBe('Can keep writing while disconnected')
})

it('keeps an unsent conversation usable after reconnect without loading missing durable history', async () => {
	const { owner, wait, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const started = await owner.newConversation(project.id)
	const unsent = await owner.newConversation(project.id)
	owner.saveDraft(unsent.id, 'My unsubmitted request')
	const failed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
	owner.send(started.id, 'Break connection')
	await failed
	await owner.reconnect(project.id)
	expect(await owner.listConversations(project.id)).toContainEqual(
		expect.objectContaining({ id: unsent.id }),
	)
	await Promise.all([
		owner.openConversation(project.id, unsent.id),
		owner.openConversation(project.id, unsent.id),
	])
	expect(owner.draft(unsent.id)).toBe('My unsubmitted request')
	const review = permission()
	owner.send(unsent.id, owner.draft(unsent.id))
	const request = await review
	expect(request.sessionId).toBe(unsent.id)
	expect(request.calls[0]?.input).toEqual({ prompt: 'My unsubmitted request' })
	const ended = wait((event) => event.kind === 'state' && !event.running)
	owner.approve(unsent.id, request.id, true)
	await ended
	expect((await owner.openConversation(project.id, unsent.id)).messages).toContainEqual({
		role: 'assistant',
		text: 'Approved answer',
	})
})

it('edits and removes queued identities without overwriting a draft or another conversation', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const a = await owner.newConversation(project.id)
	const b = await owner.newConversation(project.id)
	const pending = permission()
	owner.send(a.id, 'Wait for approval')
	await pending
	owner.send(a.id, 'Repeated queued text')
	owner.send(a.id, 'Repeated queued text')
	const queue = (await owner.openConversation(project.id, a.id)).thread?.queuedItems ?? []
	expect(queue).toHaveLength(2)
	expect(queue[0]?.id).not.toBe(queue[1]?.id)
	owner.saveDraft(a.id, 'Already writing a different request')
	expect(() => owner.takeQueued(a.id, queue[1]?.id)).toThrow('current draft')
	expect(owner.draft(a.id)).toBe('Already writing a different request')
	expect((await owner.openConversation(project.id, a.id)).thread?.queued).toHaveLength(2)
	expect(() => owner.removeQueued(b.id, queue[0]?.id ?? '')).toThrow('already started')
	owner.removeQueued(a.id, queue[0]?.id ?? '')
	expect((await owner.openConversation(project.id, a.id)).thread?.queuedItems).toEqual([queue[1]])
	expect(() => owner.removeQueued(a.id, queue[0]?.id ?? '')).toThrow('already started')
	owner.saveDraft(a.id, '')
	expect(owner.takeQueued(a.id, queue[1]?.id)).toBe('Repeated queued text')
	expect(owner.draft(a.id)).toBe('Repeated queued text')
	expect((await owner.openConversation(project.id, a.id)).thread?.queued).toEqual([])
})

it('keeps project landing drafts separate from conversations without creating a session', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const landing = `project:${project.id}`
	owner.saveDraft(landing, 'My first unsent project prompt')
	expect(owner.draft(landing)).toBe('My first unsent project prompt')
	expect(await owner.listConversations(project.id)).toEqual([])
	const conversation = await owner.newConversation(project.id)
	owner.saveDraft(conversation.id, 'Different conversation draft')
	expect(owner.draft(landing)).toBe('My first unsent project prompt')
	expect(owner.draft(conversation.id)).toBe('Different conversation draft')
	expect(() => owner.saveDraft('project:unknown', 'Rejected')).toThrow('Unknown project')
	expect(() => owner.saveDraft(landing, 'x'.repeat(50_001))).toThrow('50,000')
})
