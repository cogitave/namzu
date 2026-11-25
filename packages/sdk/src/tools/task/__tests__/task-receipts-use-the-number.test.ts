import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { FileTaskStore } from '../../../store/task/file.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { TaskStore } from '../../../types/task/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { buildTaskTools } from '../index.js'
import { plainTaskReceipt } from '../number.js'

/**
 * A team's screens call a task `#2`. The task tools' receipts do too, and keep the id in
 * the model's text because the next call needs it. A list only one session uses has no
 * numbers, so there the receipts are as they were.
 */

const SESSION = '8240c48a-1635-4cd9-80cd-a75964d63808' as SessionId
const TURN = '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e' as TurnId
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(store: TaskStore) {
	const tools = buildTaskTools(store, { sessionId: SESSION, turnId: TURN, member: 'one' })
	const byName = new Map(tools.map((tool) => [tool.name, tool]))
	const presenter = createToolPresenter({
		get: (name: string) => byName.get(name),
	} as unknown as Pick<ToolManager, 'get'>)
	const run = (name: string, input: unknown) =>
		(byName.get(name) as ToolDefinition).execute(input as never, {} as never)
	return { presenter, run }
}

function team() {
	const rootDir = mkdtempSync(join(tmpdir(), 'namzu-task-number-'))
	roots.push(rootDir)
	return setup(new FileTaskStore({ listId: 'team-a', rootDir }))
}

describe('task receipts on a team list', () => {
	it('names a created task by its number and keeps the id for the model', async () => {
		const { run, presenter } = team()
		const first = await run('task_create', { subject: 'Write it' })
		const second = await run('task_create', { subject: 'Test it' })
		expect(first.output).toMatch(/^Task created: #1 \(id [0-9a-f-]{36}\) — "Write it"$/)
		expect(second.output).toContain('#2 (id ')
		expect(second.data).toMatchObject({ number: 2, subject: 'Test it' })
		expect(presenter.presentResult('task_create', {}, second)).toEqual({
			kind: 'generic',
			label: 'Task #2 added',
		})
	})

	it('words an update with the number, and the person row has no id', async () => {
		const { run, presenter } = team()
		await run('task_create', { subject: 'Write it' })
		const created = await run('task_create', { subject: 'Test it' })
		const id = (created.data as { id: string }).id
		const done = await run('task_update', { id, status: 'in_progress' })
		expect(done.output).toBe(`Task #2 (id ${id}) updated — status: in_progress`)
		expect(plainTaskReceipt(done.output)).toBe('Task #2 updated — status: in_progress')
		const view = presenter.presentResult('task_update', { id }, done)
		expect(view).toEqual({ kind: 'generic', label: 'Task #2 started' })
		const closed = await run('task_update', { id, status: 'completed' })
		expect(presenter.presentResult('task_update', { id }, closed)).toEqual({
			kind: 'generic',
			label: 'Task #2 completed',
		})
		expect(JSON.stringify(view)).not.toMatch(UUID)
	})

	it('numbers the task in a refusal too', async () => {
		const { run } = team()
		const created = await run('task_create', { subject: 'Write it' })
		const id = (created.data as { id: string }).id
		await run('task_update', { id, status: 'in_progress' })
		const again = await run('task_update', { id, status: 'in_progress', owner: 'two' })
		expect(again.success).toBe(false)
		expect(plainTaskReceipt(again.output)).toMatch(/^Task #1 is /)
	})

	it('puts the number on a read and on every row of the list', async () => {
		const { run } = team()
		await run('task_create', { subject: 'Write it' })
		const created = await run('task_create', { subject: 'Test it' })
		const id = (created.data as { id: string }).id
		const got = await run('task_get', { id })
		expect(got.output.startsWith('#2 Test it [pending]')).toBe(true)
		expect(got.data).toMatchObject({ number: 2 })
		const listed = await run('task_list', {})
		const tasks = (listed.data as { tasks: { number: number; subject: string }[] }).tasks
		expect(tasks.map((t) => [t.number, t.subject])).toEqual([
			[1, 'Write it'],
			[2, 'Test it'],
		])
	})
})

describe('task receipts on a list one session uses', () => {
	it('keeps the id, with no number anywhere', async () => {
		const { run, presenter } = setup(new InMemoryTaskStore())
		const created = await run('task_create', { subject: 'Write it' })
		const id = (created.data as { id: string }).id
		expect(created.output).toBe(`Task created: ${id} — "Write it"`)
		expect(created.data).not.toHaveProperty('number')
		const done = await run('task_update', { id, status: 'completed' })
		expect(done.output).toBe(`Task ${id} updated — status: completed`)
		expect(plainTaskReceipt(done.output)).toBe(done.output)
		expect(presenter.presentResult('task_update', { id }, done)).toMatchObject({
			visibility: 'hidden',
		})
		const listed = await run('task_list', {})
		expect((listed.data as { tasks: object[] }).tasks[0]).not.toHaveProperty('number')
	})
})
