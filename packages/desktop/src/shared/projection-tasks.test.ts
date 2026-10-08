import type { AcpTask } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { applyEvent, emptyThread, restoreMessages } from './projection.js'
import { readTaskUpdate, readTasks } from './task-protocol.js'

const task: AcpTask = {
	taskId: 'planning-task',
	subject: 'Verify output',
	status: 'pending',
	blockedBy: ['dependency'],
	owner: 'assigned-agent',
}
it('retains the session plan through later prompts/history and replaces cleared fields without changing transcript activity', () => {
	let thread = applyEvent(emptyThread(), { kind: 'tasks', sessionId: 'session', tasks: [task] })
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 'session', prompt: 'Continue' })
	expect(thread.tasks).toEqual([task])
	const timeline = thread.timeline
	const { owner: _owner, ...withoutOwner } = task
	thread = applyEvent(thread, {
		kind: 'task',
		sessionId: 'session',
		task: { ...withoutOwner, status: 'failed', blockedBy: [] },
	})
	expect(thread.tasks).toEqual([{ ...withoutOwner, status: 'failed', blockedBy: [] }])
	expect(thread.timeline).toBe(timeline)
	thread = restoreMessages(thread, [{ role: 'user', text: 'Cold history' }])
	expect(thread.tasks[0]?.status).toBe('failed')
	thread = applyEvent(thread, { kind: 'task', sessionId: 'session', task, deleted: true })
	expect(thread.tasks).toEqual([])
})
it('keeps retained states on unavailable reads and makes an authoritative empty list remove old records', () => {
	const loaded = applyEvent(emptyThread(), { kind: 'tasks', sessionId: 'session', tasks: [task] })
	const unavailable = applyEvent(loaded, {
		kind: 'tasks',
		sessionId: 'session',
		notice: 'Unavailable',
	})
	expect(unavailable.tasks).toEqual([task])
	expect(unavailable.tasksNotice).toBe('Unavailable')
	const updated = applyEvent(unavailable, {
		kind: 'task',
		sessionId: 'session',
		task: { ...task, status: 'failed' },
	})
	expect(updated.tasksNotice).toBe('Unavailable')
	expect(applyEvent(unavailable, { kind: 'tasks', sessionId: 'session', tasks: [] })).toMatchObject(
		{ tasks: [], tasksNotice: undefined },
	)
})
it('admits only complete typed public rows and does not project private metadata or partial invalid snapshots', () => {
	expect(
		readTasks({ tasks: [{ ...task, tenantId: 'private-tenant', metadata: { secret: true } }] }),
	).toEqual([task])
	expect(
		readTaskUpdate({ sessionId: 'session', task, deleted: true, rawEvent: 'private' }),
	).toEqual({ sessionId: 'session', task, deleted: true })
	for (const invalid of [
		{ ...task, status: 'done' },
		{ ...task, blockedBy: undefined },
		{ ...task, blockedBy: [4] },
	]) {
		expect(readTaskUpdate({ sessionId: 'session', task: invalid })).toBeUndefined()
		expect(readTasks({ tasks: [task, invalid] })).toBeUndefined()
	}
	expect(readTasks({ tasks: [task, task] })).toBeUndefined()
})
it("keeps a task's active form, bounded, and refuses one that is not text", () => {
	expect(readTasks({ tasks: [{ ...task, activeForm: 'Running the tests' }] })).toEqual([
		{ ...task, activeForm: 'Running the tests' },
	])
	expect(
		readTasks({ tasks: [{ ...task, activeForm: 'x'.repeat(500) }] })?.[0]?.activeForm,
	).toHaveLength(200)
	expect(readTasks({ tasks: [{ ...task, activeForm: 4 }] })).toBeUndefined()
})
it('updates a task in place and keeps the order of the list', () => {
	const first = { ...task, taskId: 'a', blockedBy: [] }
	const second = { ...task, taskId: 'b', blockedBy: [] }
	const third = { ...task, taskId: 'c', blockedBy: [] }
	let thread = applyEvent(emptyThread(), {
		kind: 'tasks',
		sessionId: 'session',
		tasks: [first, second, third],
	})
	thread = applyEvent(thread, {
		kind: 'task',
		sessionId: 'session',
		task: { ...second, status: 'completed' },
	})
	expect(thread.tasks.map((item) => [item.taskId, item.status])).toEqual([
		['a', 'pending'],
		['b', 'completed'],
		['c', 'pending'],
	])
	thread = applyEvent(thread, { kind: 'task', sessionId: 'session', task: first, deleted: true })
	expect(thread.tasks.map((item) => item.taskId)).toEqual(['b', 'c'])
	thread = applyEvent(thread, {
		kind: 'task',
		sessionId: 'session',
		task: { ...first, taskId: 'd' },
	})
	expect(thread.tasks.map((item) => item.taskId)).toEqual(['b', 'c', 'd'])
})
