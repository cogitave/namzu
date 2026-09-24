import { describe, expect, it } from 'vitest'

import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { buildTaskTools } from '../index.js'

/**
 * The task tools show a person words, never the handles the model uses.
 *
 * Without presenters of their own these fell through to the generic view,
 * which is how an operator came to read `Task update({"id":"01a0…",
 * "status":"completed"})` above `Task 01a0… updated — status: completed`. The
 * model still needs the id in its receipt; the screen never does.
 */

const SESSION = '8240c48a-1635-4cd9-80cd-a75964d63808' as SessionId
const TURN = '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e' as TurnId
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function setup() {
	const store = new InMemoryTaskStore()
	const tools = buildTaskTools(store, { sessionId: SESSION, turnId: TURN })
	const byName = new Map(tools.map((tool) => [tool.name, tool]))
	const registry = { get: (name: string) => byName.get(name) } as unknown as Pick<
		ToolManager,
		'get'
	>
	const tool = (name: string) => byName.get(name) as ToolDefinition
	return { presenter: createToolPresenter(registry), tool, store }
}

const run = (tool: ToolDefinition, input: unknown) => tool.execute(input as any, {} as any)

describe('task tool presentation', () => {
	it('names the added task and hides a successful receipt that carries its id', async () => {
		const { presenter, tool } = setup()
		const input = { subject: 'Çalışma alanını incele', owner: 'namzu' }
		expect(presenter.presentCall('task_create', input)).toEqual({
			kind: 'generic',
			presentation: 'activity',
			label: 'Add task · Çalışma alanını incele',
		})
		const result = await run(tool('task_create'), input)
		expect(result.output, 'the model keeps the handle it needs').toMatch(UUID)
		const view = presenter.presentResult('task_create', input, result)
		expect(view).toMatchObject({ kind: 'generic', visibility: 'hidden' })
		expect(JSON.stringify(view)).not.toMatch(UUID)
		expect(JSON.stringify(view)).not.toContain('namzu')
	})

	it('says what an update does, never the id or the JSON it was given', async () => {
		const { presenter, tool } = setup()
		const created = await run(tool('task_create'), { subject: 'Write the parser' })
		const id = (created.data as { id: string }).id
		for (const [status, verb] of [
			['in_progress', 'Start task'],
			['completed', 'Complete task'],
			['pending', 'Reopen task'],
			['deleted', 'Remove task'],
			[undefined, 'Update task'],
		] as const) {
			const call = presenter.presentCall('task_update', { id, status })
			expect(call).toEqual({ kind: 'generic', presentation: 'activity', label: verb })
			expect(JSON.stringify(call)).not.toContain(id)
		}
		const done = await run(tool('task_update'), { id, status: 'completed' })
		expect(done.data, 'the receipt names its subject for hosts that group rows').toMatchObject({
			subject: 'Write the parser',
			status: 'completed',
		})
		expect(presenter.presentResult('task_update', { id }, done)).toMatchObject({
			visibility: 'hidden',
		})
	})

	it('reports a missing task without echoing the id the model passed', async () => {
		const { presenter, tool } = setup()
		const id = '01a0c96a-0000-4000-8000-000000000000'
		const missing = await run(tool('task_update'), { id, status: 'completed' })
		expect(missing.success).toBe(false)
		const view = presenter.presentResult('task_update', { id }, missing)
		expect(view).toEqual({ kind: 'generic', label: 'No task has that id' })
	})

	it('counts the list with the right plural', async () => {
		const { presenter, tool } = setup()
		const empty = await run(tool('task_list'), {})
		expect(presenter.presentResult('task_list', {}, empty)).toEqual({
			kind: 'generic',
			label: 'No tasks yet',
		})
		await run(tool('task_create'), { subject: 'One' })
		const one = await run(tool('task_list'), {})
		expect(one.output).toBe('1 task: 0 completed, 0 in progress, 1 pending.')
		expect(presenter.presentResult('task_list', {}, one)).toEqual({
			kind: 'generic',
			label: 'Tasks · 0/1 done',
		})
		expect(presenter.presentCall('task_list', {})).toEqual({
			kind: 'generic',
			presentation: 'activity',
			label: 'Check tasks',
		})
		await run(tool('task_create'), { subject: 'Two' })
		expect((await run(tool('task_list'), {})).output).toBe(
			'2 tasks: 0 completed, 0 in progress, 2 pending.',
		)
	})

	it('keeps a long subject to one bounded line', () => {
		const { presenter } = setup()
		const call = presenter.presentCall('task_create', { subject: `${'uzun '.repeat(60)}\nson` })
		const label = (call as { label: string }).label
		expect(label).not.toContain('\n')
		expect(label.length).toBeLessThanOrEqual('Add task · '.length + 100)
		expect(label.endsWith('…')).toBe(true)
	})
})
