import { describe, expect, it } from 'vitest'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { buildTaskTools } from '../index.js'

describe('failed planning tasks', () => {
	it('accepts a real failure, reports it distinctly and does not wait for the failed blocker', async () => {
		const store = new InMemoryTaskStore()
		const sessionId = generateSessionId()
		const turnId = generateTurnId()
		const tools = buildTaskTools(store, {
			sessionId,
			turnId,
			turnStartedAt: 0,
		})
		const byName = new Map(tools.map((tool) => [tool.name, tool]))
		const update = byName.get('task_update')
		const list = byName.get('task_list')
		if (!update || !list) throw new Error('Planning tools are missing')
		const first = await store.create({
			sessionId,
			turnId,
			subject: 'Obtain required source',
		})
		const dependent = await store.create({
			sessionId,
			turnId,
			subject: 'Review outcome',
		})
		await store.block(first.id, dependent.id)
		const input = update.inputSchema.parse({ id: first.id, status: 'failed' })
		const receipt = await update.execute(input, {} as never)
		expect(receipt.success).toBe(true)
		expect((await store.get(first.id))?.status).toBe('failed')
		expect((await store.get(first.id))?.completedAt).toBeTypeOf('number')
		const result = await list.execute({}, {} as never)
		expect(result.data).toMatchObject({
			stats: { total: 2, pending: 1, in_progress: 0, completed: 0, failed: 1 },
			tasks: [
				expect.objectContaining({ id: first.id, status: 'failed' }),
				expect.objectContaining({
					id: dependent.id,
					status: 'pending',
					blockedBy: undefined,
				}),
			],
		})
		expect(result.output).toContain('1 failed')
		const registry = { get: (name: string) => byName.get(name) } as Pick<ToolManager, 'get'>
		const presenter = createToolPresenter(registry)
		expect(presenter.presentCall('task_update', input)).toMatchObject({
			label: 'Fail task',
		})
		expect(presenter.presentResult('task_list', {}, result)).toMatchObject({
			label: 'Tasks · 0/2 done · 1 failed',
		})
		const nextTurn = buildTaskTools(store, {
			sessionId,
			turnId: generateTurnId(),
			turnStartedAt: Number.MAX_SAFE_INTEGER,
		}).find((tool) => tool.name === 'task_list')
		if (!nextTurn) throw new Error('Planning list tool is missing')
		expect((await nextTurn.execute({}, {} as never)).data).toMatchObject({
			tasks: [expect.objectContaining({ id: dependent.id, status: 'pending' })],
			stats: { total: 1, failed: 0 },
		})
	})
})
