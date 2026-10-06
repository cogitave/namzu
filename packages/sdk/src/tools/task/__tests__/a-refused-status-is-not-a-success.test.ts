import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { SessionPaths } from '../../../session/paths.js'
import { DiskTaskStore } from '../../../store/task/disk.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { TaskStore } from '../../../types/task/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { buildTaskTools } from '../index.js'

describe.each(['memory', 'disk'] as const)('a refused task status in the %s store', (kind) => {
	let home: string | undefined
	let store: TaskStore
	let reopen: () => TaskStore
	const sessionId = generateSessionId()
	const turnId = generateTurnId()

	beforeEach(async () => {
		if (kind === 'disk') {
			home = await mkdtemp(join(tmpdir(), 'namzu-task-status-receipt-'))
			const paths = new SessionPaths({ home, slug: '-task-status-receipt' })
			reopen = () => new DiskTaskStore({ paths, session: { sessionId } })
			store = reopen()
		} else {
			store = new InMemoryTaskStore()
			reopen = () => store
		}
	})

	afterEach(async () => {
		if (home) await removeTempDirAsync(home)
		home = undefined
	})

	function setup() {
		const tools = new Map(
			buildTaskTools(store, { sessionId, turnId }).map((tool) => [tool.name, tool]),
		)
		const update = tools.get('task_update')
		if (!update) throw new Error('Missing task update tool')
		const registry = { get: (name: string) => tools.get(name) } as Pick<ToolManager, 'get'>
		return {
			run: (input: unknown) => update.execute(update.inputSchema.parse(input), {} as never),
			presenter: createToolPresenter(registry),
		}
	}

	it.each([
		['in_progress', 'pending'],
		['completed', 'pending'],
		['failed', 'pending'],
		['completed', 'failed'],
		['failed', 'completed'],
		['completed', 'in_progress'],
	] as const)('reports %s → %s as refused with the actual state', async (initial, requested) => {
		const task = await store.create({ sessionId, turnId, subject: 'Original work' })
		await store.update(task.id, { status: initial })
		const before = await reopen().get(task.id)
		const { run, presenter } = setup()
		const input = { id: task.id, status: requested }
		const result = await run(input)
		expect(result.success).toBe(false)
		expect(result.output).toContain(`requested status "${requested}" could not be confirmed`)
		expect(result.output).toContain(`returned status is "${initial}"`)
		expect(result.output).toContain('Other requested edits may have applied')
		expect(result.data).toMatchObject({ status: initial, requestedStatus: requested })
		expect(await reopen().get(task.id)).toEqual(before)
		const view = presenter.presentResult('task_update', input, result)
		expect(view).toEqual({
			kind: 'generic',
			label: `Task remains ${initial.replace('_', ' ')}; other edits may have applied`,
		})
		expect(JSON.stringify(view)).not.toContain(task.id)
	})

	it('reports refusal without hiding other edits and dependency edges that committed', async () => {
		const task = await store.create({ sessionId, turnId, subject: 'Original work' })
		const blocker = await store.create({ sessionId, turnId, subject: 'New dependency' })
		await store.update(task.id, { status: 'completed' })
		const { run, presenter } = setup()
		const input = {
			id: task.id,
			status: 'pending',
			subject: 'Follow-up notes',
			description: 'Needs another attempt',
			owner: 'reviewer',
			metadata: { attempt: 2 },
			addBlockedBy: [blocker.id],
		}
		const result = await run(input)
		expect(result.success).toBe(false)
		expect(result.data).toMatchObject({
			status: 'completed',
			requestedStatus: 'pending',
			subject: 'Follow-up notes',
			owner: 'reviewer',
		})
		expect(await reopen().get(task.id)).toMatchObject({
			status: 'completed',
			subject: 'Follow-up notes',
			description: 'Needs another attempt',
			owner: 'reviewer',
			metadata: { attempt: 2 },
			blockedBy: [blocker.id],
		})
		expect(await reopen().get(blocker.id)).toMatchObject({ blocks: [task.id] })
		expect(result.output).toContain('Other requested edits may have applied')
		expect(result.output).toContain('create a new task for follow-up work')
		expect(presenter.presentCall('task_update', input)).toMatchObject({
			label: 'Set task pending · Follow-up notes',
		})
		expect(presenter.presentResult('task_update', input, result)).not.toHaveProperty(
			'visibility',
			'hidden',
		)
	})

	it('keeps forward transitions, matching-status calls and metadata edits successful', async () => {
		const task = await store.create({ sessionId, turnId, subject: 'Original work' })
		const { run, presenter } = setup()
		for (const input of [
			{ id: task.id, status: 'pending' },
			{ id: task.id, status: 'in_progress' },
			{ id: task.id, status: 'completed' },
			{ id: task.id, status: 'completed' },
			{ id: task.id, description: 'Verified from the output' },
		]) {
			const result = await run(input)
			expect(result.success).toBe(true)
			expect(result.data).not.toHaveProperty('requestedStatus')
			expect(presenter.presentResult('task_update', input, result)).toMatchObject({
				visibility: 'hidden',
			})
		}
		expect(await reopen().get(task.id)).toMatchObject({
			status: 'completed',
			description: 'Verified from the output',
		})
	})

	if (kind === 'memory')
		it('does not claim a concurrent intermediate transition never applied', async () => {
			const task = await store.create({ sessionId, turnId, subject: 'Concurrent work' })
			const { run } = setup()
			const observed: string[] = []
			const unsubscribe = store.on((event) => observed.push(event.task.status))
			const [started, completed] = await Promise.all([
				run({ id: task.id, status: 'in_progress' }),
				run({ id: task.id, status: 'completed' }),
			])
			unsubscribe()
			// The memory store returns a shared Task. Both tool continuations
			// observe completed, although the first transition did apply.
			expect(observed).toEqual(['in_progress', 'completed'])
			expect(started.success).toBe(false)
			expect(started.data).toMatchObject({
				status: 'completed',
				requestedStatus: 'in_progress',
			})
			expect(started.output).toContain('could not be confirmed; returned status is "completed"')
			expect(started.output).not.toContain('was not applied')
			expect(completed.success).toBe(true)
			expect(await store.get(task.id)).toMatchObject({ status: 'completed' })
		})
})
