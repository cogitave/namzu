import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'
import { RuntimeClient } from './rpc-client.js'

const owners: Operator[] = []
const runtimeRequest = RuntimeClient.prototype.request
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	vi.restoreAllMocks()
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
function harness(noTasks = false) {
	let client!: RuntimeClient
	const requests: { method: string; params: unknown }[] = []
	const request = runtimeRequest
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		client = this
		requests.push({ method, params })
		return request.call(this, method, params, timeout)
	})
	const events = new EventEmitter()
	const recorded: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-tasks-process.mjs', import.meta.url))],
			env: { ...process.env, ...(noTasks ? { FIXTURE_NO_TASKS: '1' } : {}) },
		},
		(event) => {
			recorded.push(event)
			events.emit('event', event)
		},
	)
	owners.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean) =>
		new Promise<DesktopEvent>((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					events.off('event', receive)
					resolve(event)
				}
			}
			events.on('event', receive)
		})
	return { owner, recorded, requests, wait, client: () => client }
}
const settled = (event: DesktopEvent) => event.kind === 'state' && !event.running
const row = (taskId: string, status = 'pending') => ({
	taskId,
	subject: `Plan ${taskId}`,
	status,
	blockedBy: [],
})

it('cold-loads durable planning states before any model request and preserves failure rather than claiming completion', async () => {
	const { owner, requests } = harness()
	const project = await owner.openProject(process.cwd())
	const result = await owner.openConversation(project.id, 'cold-session')
	expect(result.thread?.tasks).toEqual([row('first', 'in_progress'), row('second', 'failed')])
	expect(requests.filter(({ method }) => method === 'session/prompt')).toEqual([])
	expect(requests.find(({ method }) => method === 'initialize')?.params).toMatchObject({
		capabilities: ['permission', 'namzu/tasks'],
	})
	expect(requests.find(({ method }) => method === 'namzu/tasks/list')?.params).toEqual({
		sessionId: 'cold-session',
	})
	const other = await owner.openProject(fileURLToPath(new URL('.', import.meta.url)))
	await expect(owner.openConversation(other.id, 'cold-session')).rejects.toThrow(
		'belongs to another project',
	)
})
it('accepts only the matching active session’s typed notifications and reconciles deletion on idle without touching drafts or queue', async () => {
	const { owner, client, wait, recorded } = harness()
	const project = await owner.openProject(process.cwd())
	await owner.openConversation(project.id, 'cold-session')
	await owner.openConversation(project.id, 'other-session')
	owner.saveDraft('cold-session', 'Keep draft')
	const permission = wait((event) => event.kind === 'permission')
	await owner.send('cold-session', 'Watch task updates')
	const review = await permission
	if (review.kind !== 'permission') throw new Error('Missing permission fixture')
	await owner.send('cold-session', 'Queued authored message')
	await client().request('test/task', { sessionId: 'unknown-session', task: row('foreign') })
	await client().request('test/task', { sessionId: 'other-session', task: row('idle-foreign') })
	await client().request('test/task', {
		sessionId: 'cold-session',
		task: { ...row('malformed'), status: 'done' },
	})
	await client().request('test/task', {
		sessionId: 'cold-session',
		task: {
			...row('first', 'failed'),
			owner: 'assigned',
			blockedBy: ['second'],
			metadata: 'PRIVATE',
		},
	})
	await client().request('test/task', { sessionId: 'cold-session', task: row('first', 'failed') })
	await client().request('test/task', {
		sessionId: 'cold-session',
		task: row('second', 'failed'),
		deleted: true,
	})
	const live = await owner.openConversation(project.id, 'cold-session')
	expect(live.thread?.tasks).toEqual([row('first', 'failed')])
	expect(live.thread?.queued).toEqual(['Queued authored message'])
	expect(owner.draft('cold-session')).toBe('Keep draft')
	expect((await owner.openConversation(project.id, 'other-session')).thread?.tasks).toEqual([
		row('other'),
	])
	expect(recorded.filter((event) => event.kind === 'task')).toHaveLength(3)
	expect(JSON.stringify(recorded.filter((event) => event.kind === 'task'))).not.toContain('PRIVATE')
	const stopped = wait(settled)
	await owner.cancel('cold-session')
	await stopped
	// The fixture stored a malformed row; an invalid full read keeps the
	// streamed states and reports unavailability, without partially accepting it.
	expect((await owner.openConversation(project.id, 'cold-session')).thread).toMatchObject({
		tasks: [row('first', 'failed')],
		tasksNotice: expect.stringContaining('unavailable'),
	})
	expect(owner.draft('cold-session')).toBe('Keep draft')
})
it('does not let a delayed cold snapshot resurrect a deleted task and performs a fresh authoritative read after settlement', async () => {
	const { owner, client, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const entered = deferred<void>()
	const snapshot = deferred<unknown>()
	const request = runtimeRequest
	let reads = 0
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		if (method === 'namzu/tasks/list' && ++reads === 1) {
			entered.resolve()
			return snapshot.promise
		}
		return request.call(this, method, params, timeout)
	})
	try {
		const opening = owner.openConversation(project.id, 'cold-session')
		await entered.promise
		const stopped = wait(settled)
		await owner.send('cold-session', 'Finish')
		await client().request('test/task', {
			sessionId: 'cold-session',
			task: row('second', 'failed'),
			deleted: true,
		})
		snapshot.resolve({ tasks: [row('first', 'in_progress'), row('second', 'failed')] })
		const loaded = await opening
		expect(loaded.thread?.tasks.some((task) => task.taskId === 'second')).toBe(false)
		await stopped
		expect((await owner.openConversation(project.id, 'cold-session')).thread?.tasks).toEqual([
			row('first', 'in_progress'),
		])
		expect(reads).toBe(3)
	} finally {
		snapshot.resolve({ tasks: [] })
	}
})
it('discards a pending snapshot when the exact owned connection closes', async () => {
	const { owner, client, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const entered = deferred<void>()
	const snapshot = deferred<unknown>()
	const request = runtimeRequest
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		if (method === 'namzu/tasks/list') {
			entered.resolve()
			return snapshot.promise
		}
		return request.call(this, method, params, timeout)
	})
	try {
		const opening = owner.openConversation(project.id, 'cold-session')
		await entered.promise
		const closed = wait((event) => event.kind === 'connection' && event.project.status === 'error')
		await expect(client().request('test/exit')).rejects.toThrow('connection closed')
		await closed
		snapshot.resolve({ tasks: [row('stale-private-task')] })
		await opening
		expect((await owner.openConversation(project.id, 'cold-session')).thread?.tasks).toEqual([])
	} finally {
		snapshot.resolve({ tasks: [] })
	}
})
it('keeps older CLI peers usable without invoking an unadvertised task route', async () => {
	const { owner, requests } = harness(true)
	const project = await owner.openProject(process.cwd())
	expect((await owner.openConversation(project.id, 'cold-session')).thread?.tasks).toEqual([])
	expect(requests.some(({ method }) => method === 'namzu/tasks/list')).toBe(false)
})
it('explicitly refreshes idle disk-only outcomes and deletion without a model call, and skips active or unknown sessions', async () => {
	const { owner, client, requests, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const before = (await owner.openConversation(project.id, 'cold-session')).thread?.tasks
	await client().request('test/task', {
		sessionId: 'cold-session',
		task: row('first', 'completed'),
	})
	await client().request('test/task', {
		sessionId: 'cold-session',
		task: row('second', 'failed'),
		deleted: true,
	})
	await client().request('test/task', { sessionId: 'cold-session', task: row('third', 'failed') })
	expect((await owner.openConversation(project.id, 'cold-session')).thread?.tasks).toEqual(before)
	await owner.refreshTasks('cold-session')
	expect((await owner.openConversation(project.id, 'cold-session')).thread?.tasks).toEqual([
		row('first', 'completed'),
		row('third', 'failed'),
	])
	expect(requests.filter(({ method }) => method === 'session/prompt')).toEqual([])
	await expect(owner.refreshTasks('unknown-session')).rejects.toThrow(
		'Open this conversation first',
	)
	const permission = wait((event) => event.kind === 'permission')
	await owner.send('cold-session', 'Watch')
	await permission
	const readCount = requests.filter(({ method }) => method === 'namzu/tasks/list').length
	await owner.refreshTasks('cold-session')
	expect(requests.filter(({ method }) => method === 'namzu/tasks/list')).toHaveLength(readCount)
	const stopped = wait(settled)
	await owner.cancel('cold-session')
	await stopped
})
