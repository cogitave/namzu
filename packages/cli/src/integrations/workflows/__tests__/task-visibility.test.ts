import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { workflowHarness } from './harness.js'

const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
afterEach(async () => {
	for (const h of open.splice(0)) {
		h.gate.open()
		await h.close()
		removeTempDir(h.cwd)
	}
})
async function held(partialText?: string) {
	const h = await workflowHarness({ held: true, partialText })
	open.push(h)
	await h.start({
		script: `export const meta = { name: 'visibility', description: 'Read-only greetings', phases: [{ title: 'Greet' }] }
return await parallel([1, 2].map(n => () => agent('Return a greeting, no tools.', { label: 'greeting-' + n, phase: 'Greet' })))`,
	})
	await h.until(() => h.gate.waiting() === 2)
	return h
}

it('lists active workflow children, retrieves one while it runs, then waits for its result', async () => {
	const h = await held('PUBLIC_PARTIAL')
	const list = await h.runtime.agentTaskListTool.execute({}, h.context)
	const parsed = JSON.parse(list.output)
	expect(parsed.total).toBe(2)
	expect(parsed.omitted).toBe(0)
	expect(parsed.tasks).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				description: 'greeting-1',
				state: 'running',
				workflow: 'visibility',
			}),
			expect.objectContaining({ description: 'greeting-2', state: 'running', phase: 'Greet' }),
		]),
	)
	const task_id = parsed.tasks[0].task_id
	const observed = await h.runtime.agentTaskListTool.execute(
		{ task_id, include_output: true },
		h.context,
	)
	const selected = JSON.parse(observed.output)
	expect(selected).toMatchObject({ total: 1, omitted: 0 })
	expect(selected.tasks[0]).toMatchObject({ task_id, state: 'running', outputState: 'partial' })
	expect(selected.tasks[0].output).toContain('PUBLIC_PARTIAL')
	expect(selected.tasks[0].output).toContain('kind="agent-activity"')
	expect(selected.tasks[0].output).not.toContain('ok:')
	const gateway = await h.runtime.gatewayForTurn(h.runTurns[0]!)
	let waiting!: () => void
	const waitStarted = new Promise<void>((resolve) => {
		waiting = resolve
	})
	const originalWait = gateway.waitForTask.bind(gateway)
	const spy = vi.spyOn(gateway, 'waitForTask').mockImplementation((...args) => {
		waiting()
		return originalWait(...args)
	})
	const waited = h.runtime.waitForTaskTool.execute({ task_id }, h.context)
	await waitStarted
	expect(h.gate.waiting()).toBe(2)
	h.gate.open()
	const result = await waited
	spy.mockRestore()
	expect(result.success).toBe(true)
	expect(result.output).toContain('ok:Return a greeting, no tools.')
	await h.untilEnded()
})

it('allows a parent message and cancellation for the exact live workflow child, without affecting its sibling', async () => {
	const h = await held()
	const list = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
	const task_id = list.tasks[0].task_id
	const message = await h.runtime.sendMessageTool.execute(
		{ task_id, message: 'Keep the greeting short.' },
		h.context,
	)
	expect(message.success).toBe(true)
	expect(message.data).toMatchObject({ task_id, status: 'queued' })
	const cancelled = await h.runtime.cancelAgentTool.execute({ task_id }, h.context)
	expect(cancelled.success).toBe(true)
	await h.until(() => h.gate.waiting() === 1)
	const after = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
	expect(after.tasks).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ task_id, status: 'canceled' }),
			expect.objectContaining({ task_id: list.tasks[1].task_id, state: 'running' }),
		]),
	)
})

it('refuses listing, inspection, wait, message and cancellation from another conversation', async () => {
	const h = await held('PRIVATE_CHILD_TEXT')
	const own = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
	const task_id = own.tasks[0].task_id
	const foreign = await h.foreignContext()
	expect(JSON.parse((await h.runtime.agentTaskListTool.execute({}, foreign)).output).total).toBe(0)
	for (const result of await Promise.all([
		h.runtime.agentTaskListTool.execute({ task_id, include_output: true }, foreign),
		h.runtime.waitForTaskTool.execute({ task_id }, foreign),
		h.runtime.sendMessageTool.execute({ task_id, message: 'Foreign correction' }, foreign),
		h.runtime.cancelAgentTool.execute({ task_id }, foreign),
	])) {
		expect(result.success).toBe(false)
		expect(JSON.stringify(result)).not.toContain('PRIVATE_CHILD_TEXT')
	}
	expect(h.gate.waiting()).toBe(2)
})

it('requires an exact task for output, preserves history validation and truthfully refuses unknown IDs', async () => {
	const h = await held()
	for (const input of [
		{ include_output: true },
		{ history: true, task_id: 'unknown', include_output: true },
		{ task_id: 'missing-agent', include_output: true },
	]) {
		const result = await h.runtime.agentTaskListTool.execute(input, h.context)
		expect(result.success).toBe(false)
	}
	expect(h.gate.waiting()).toBe(2)
})
