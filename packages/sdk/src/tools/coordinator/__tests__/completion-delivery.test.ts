import { describe, expect, it } from 'vitest'

import { CompletionInbox } from '../../../gateway/completion-inbox.js'
import type { TaskGateway, TaskHandle } from '../../../types/agent/gateway.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * Who claims a completion, and who is left to announce it.
 *
 * A worker's output normally rides back as the `tool_result` of the
 * `create_task` that launched it. Two situations have no such call:
 *
 *  - the launch was made in the background on purpose;
 *  - the launch blocked, the executor's deadline passed, and the model was
 *    told *"timed out… it may still be running"*. The worker then finished
 *    normally and its result had no reader at all.
 *
 * The second one was the live defect: a supervisor whose `create_task` timed
 * out lost both the task id and the output, and `agent_task_list` — the only
 * tool it had left — reported id, state and duration while withholding the
 * one field it was looking for. `agent_task_list` in a sleep loop was not the
 * model misbehaving; it was the only move on the board.
 *
 * These tests drive the claim/announce split from the tool side, because the
 * inbox can only tell a delivered completion from an abandoned one if the
 * tools tell it the truth.
 */

interface Harness {
	tools: ToolDefinition[]
	inbox: CompletionInbox
	settle: (handle: TaskHandle) => void
	/** Resolve the pending `waitForTask` for this task. */
	finish: (taskId: string, result: string) => void
}

function harness(opts: { autoFinish?: boolean } = {}): Harness {
	const listeners = new Set<(h: TaskHandle) => void>()
	const waiters = new Map<string, (h: TaskHandle) => void>()
	const handles = new Map<string, TaskHandle>()
	let seq = 0

	const makeHandle = (taskId: string, result?: string): TaskHandle => ({
		taskId: taskId as TaskId,
		agentId: 'reviewer',
		state: 'completed',
		createdAt: 1_000,
		completedAt: 2_000,
		...(result !== undefined
			? { result: { status: 'completed', result } as TaskHandle['result'] }
			: {}),
	})

	const gateway = {
		createTask: async () => {
			seq += 1
			const taskId = `tsk_${seq}`
			const handle: TaskHandle = { ...makeHandle(taskId), state: 'running' }
			handles.set(taskId, handle)
			return handle
		},
		waitForTask: (taskId: TaskId) =>
			new Promise<TaskHandle>((resolve) => {
				if (opts.autoFinish) {
					resolve(makeHandle(taskId, 'the worker output'))
					return
				}
				waiters.set(taskId, resolve)
			}),
		getTask: (taskId: TaskId) => handles.get(taskId),
		listTasks: () => [...handles.values()],
		cancelTask: () => undefined,
		continueTask: async () => undefined,
		onTaskCompleted: (cb: (h: TaskHandle) => void) => {
			listeners.add(cb)
			return () => listeners.delete(cb)
		},
	} as unknown as TaskGateway

	const inbox = new CompletionInbox()
	inbox.attach(gateway)

	return {
		inbox,
		tools: buildCoordinatorTools({
			gateway,
			completionInbox: inbox,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['reviewer'],
		}),
		settle: (handle) => {
			handles.set(handle.taskId, handle)
			for (const cb of listeners) cb(handle)
		},
		finish: (taskId, result) => {
			const handle = makeHandle(taskId, result)
			handles.set(taskId, handle)
			waiters.get(taskId)?.(handle)
		},
	}
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((t) => t.name === name)
	if (!tool) throw new Error(`${name} is not registered`)
	return tool
}

describe('the supervisor has a tool for every move it needs', () => {
	it('registers a way to wait, so polling is no longer the only option', () => {
		// Before this, waiting meant `continue_task` — which blocks only as a
		// side effect of sending a message, so a supervisor that just wanted
		// to wait had to invent something to say.
		const names = harness().tools.map((t) => t.name)

		expect(names).toContain('wait_for_task')
	})

	it('registers a way to cancel, which background launching makes necessary', () => {
		// `cancel_task` was defined in this file and never returned from it.
		// It matters now: a background launch can leave a worker running with
		// nothing waiting on it, and without this the supervisor could start
		// one it had no way to stop.
		expect(harness().tools.map((t) => t.name)).toContain('cancel_task')
	})

	it('gives the launching tool a deadline a real worker can meet', () => {
		// The run default is two minutes; a delegated worker doing real work
		// takes longer, and every expiry past that point produced the state
		// this whole change exists to repair. Not firing at all beats
		// recovering well.
		expect(toolNamed(harness().tools, 'create_task').timeoutMs).toBeGreaterThan(120_000)
	})

	it('gives the waiting tool a deadline longer than the executor default', () => {
		// A tool whose entire job is to wait must not be killed for waiting.
		// `ToolExecutor` reads `timeoutMs` before falling back to the run
		// default, so declaring one here is the supported way to say so.
		expect(toolNamed(harness().tools, 'wait_for_task').timeoutMs).toBeGreaterThan(120_000)
	})

	it('mounts none of them when there is no roster to delegate to', () => {
		const tools = buildCoordinatorTools({
			gateway: { onTaskCompleted: () => () => {} } as unknown as TaskGateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: [],
		})

		expect(tools.map((t) => t.name)).toEqual(['agent_task_list'])
	})
})

describe('a blocking launch claims its own completion', () => {
	it('delivers the output inline and leaves nothing to announce', () => {
		// The `dc16d58` case: this result reached the model as a tool_result,
		// so an envelope carrying it again would be the duplicate delivery
		// that removal fixed.
		const h = harness({ autoFinish: true })

		return toolNamed(h.tools, 'create_task')
			.execute({ agent_id: 'reviewer', prompt: 'go', description: 'review' }, {} as never)
			.then((result) => {
				expect(result.success).toBe(true)
				expect(result.output).toContain('the worker output')
				expect(h.inbox.drain()).toEqual([])
			})
	})
})

describe('an abandoned launch leaves its completion to be announced', () => {
	it('does not claim when the executor already gave up on the call', async () => {
		// This is the whole fix. The executor's deadline passed, the model was
		// told the tool timed out, and whatever this call returns now is
		// discarded — so claiming here would delete the worker's output for
		// good.
		const h = harness({ autoFinish: true })
		const aborted = AbortSignal.abort()

		const result = await toolNamed(h.tools, 'create_task').execute(
			{ agent_id: 'reviewer', prompt: 'go', description: 'review' },
			{ abortSignal: aborted } as never,
		)

		expect(result.success).toBe(false)
		// It also says where the result WILL turn up, rather than leaving the
		// model to conclude the work was lost.
		expect(result.output).toContain('task notification')

		h.settle({
			taskId: 'tsk_1' as TaskId,
			agentId: 'reviewer',
			state: 'completed',
			createdAt: 1_000,
			completedAt: 2_000,
			result: {
				status: 'completed',
				result: 'the worker output',
			} as TaskHandle['result'],
		})

		expect(h.inbox.drain().map((x) => x.taskId)).toEqual(['tsk_1'])
	})
})

describe('a background launch returns a handle instead of a result', () => {
	it('hands back the task id straight away and does not wait', async () => {
		// `autoFinish` is off, so `waitForTask` never resolves here. If the
		// background path awaited it, this test would hang — which is the
		// point: returning is what lets the supervisor keep working.
		const h = harness()

		const result = await toolNamed(h.tools, 'create_task').execute(
			{
				agent_id: 'reviewer',
				prompt: 'go',
				description: 'review',
				background: true,
			},
			{} as never,
		)

		expect(result.success).toBe(true)
		expect((result.data as { task_id?: string } | undefined)?.task_id).toBe('tsk_1')
		// In `output` too, not only in `data` — the executor builds the
		// tool_result from `output` alone, so an id that lives only in `data`
		// is an id the model never receives.
		expect(result.output).toContain('tsk_1')
		// And it tells the model what happens next, so "launched" does not
		// read as "finished".
		expect(result.output).toContain('task notification')
	})

	it('leaves the completion for the transcript', async () => {
		const h = harness()
		await toolNamed(h.tools, 'create_task').execute(
			{
				agent_id: 'reviewer',
				prompt: 'go',
				description: 'review',
				background: true,
			},
			{} as never,
		)

		h.settle({
			taskId: 'tsk_1' as TaskId,
			agentId: 'reviewer',
			state: 'completed',
			createdAt: 1_000,
			completedAt: 2_000,
			result: { status: 'completed', result: 'done' } as TaskHandle['result'],
		})

		expect(h.inbox.drain()).toHaveLength(1)
	})
})

describe('waiting explicitly beats listing in a loop', () => {
	it('returns the output and claims it', async () => {
		const h = harness({ autoFinish: true })
		await toolNamed(h.tools, 'create_task').execute(
			{
				agent_id: 'reviewer',
				prompt: 'go',
				description: 'review',
				background: true,
			},
			{} as never,
		)

		const result = await toolNamed(h.tools, 'wait_for_task').execute(
			{ task_id: 'tsk_1' },
			{} as never,
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('the worker output')
		// Claimed, so it is not also announced.
		expect(h.inbox.drain()).toEqual([])
	})

	it('says so plainly rather than hanging on an id that does not exist', async () => {
		const h = harness()

		const result = await toolNamed(h.tools, 'wait_for_task').execute(
			{ task_id: 'tsk_nope' },
			{} as never,
		)

		expect(result.success).toBe(false)
		expect(result.output).toContain('No task')
	})
})

describe('the task listing carries the output it always had', () => {
	async function listWith(result: string): Promise<string> {
		const h = harness()
		h.settle({
			taskId: 'tsk_1' as TaskId,
			agentId: 'reviewer',
			state: 'completed',
			createdAt: 1_000,
			completedAt: 2_000,
			result: { status: 'completed', result } as TaskHandle['result'],
		})
		const listed = await toolNamed(h.tools, 'agent_task_list').execute({}, {} as never)
		return listed.output
	}

	it('puts the worker result where the model can actually read it', async () => {
		// Two failures stacked here. The projection read `h.result` for the
		// status and the error and stopped one property short of the thing the
		// task was launched to produce — and the obvious repair, adding it to
		// `data`, would have been invisible: the executor builds the
		// tool_result from `output` alone and never reads `data`. So the fix
		// has to land in the RENDERED text, and this asserts on `output` for
		// that reason.
		expect(await listWith('the findings')).toContain('the findings')
	})

	it('names the tool that fetches the rest when it truncates', async () => {
		const output = await listWith('x'.repeat(6_000))

		expect(output).toContain('truncated')
		expect(output).toContain('wait_for_task with "tsk_1"')
	})

	it('still lists a task that has produced nothing yet', async () => {
		const h = harness()
		await toolNamed(h.tools, 'create_task').execute(
			{
				agent_id: 'reviewer',
				prompt: 'go',
				description: 'review',
				background: true,
			},
			{} as never,
		)

		const listed = await toolNamed(h.tools, 'agent_task_list').execute({}, {} as never)

		expect(listed.output).toContain('tsk_1')
		expect(listed.output).toContain('running')
	})
})
