import { afterEach, describe, expect, it } from 'vitest'

import { createUserMessage } from '@namzu/sdk'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { hypermodeReminders } from '../../../reminders/hypermode.js'
import { STOP_TASK_DESCRIPTION, STOP_WORK_GUIDANCE } from '../../subagents/stop-guidance.js'
import { launchedText } from '../notice.js'
import { WORKFLOW_TOOL_DESCRIPTION } from '../offering.js'
import { workflowHarness } from './harness.js'

const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
afterEach(async () => {
	for (const h of open.splice(0)) {
		h.gate.open()
		await h.close()
		removeTempDir(h.cwd)
	}
})

async function make(options: Parameters<typeof workflowHarness>[0] = {}) {
	const h = await workflowHarness(options)
	open.push(h)
	return h
}

/** One agent, then two side by side; with one slot the second of those waits in the queue. */
const STAGED = `export const meta = { name: 'staged', description: 'One, then two', phases: [{ title: 'Go' }] }
const first = await agent('one', { label: 'first', phase: 'Go' })
const rest = await parallel(['two', 'three'].map((p) => () => agent(p, { label: p, phase: 'Go' })))
return [first, ...rest]`

function runIdOf(result: { output: string }): string {
	const found = /\b(w[0-9a-z]{8})\b/.exec(result.output)
	if (!found) throw new Error(`no run id in ${result.output}`)
	return found[1] as string
}

describe('stop_task on a workflow run', () => {
	it('aborts the running agent, never starts the queued one, and a resume reuses what finished', async () => {
		const h = await make({ held: true, limits: { maxConcurrency: 1 } })
		const runId = runIdOf(await h.start({ script: STAGED }))
		await h.until(() => h.gate.waiting() === 1)
		h.gate.release()
		// "one" finished and was journaled; "two" now holds the only slot, "three" is queued.
		await h.until(() => h.prompts.includes('one') && h.gate.waiting() === 1)

		const stopped = await h.runtime.stopTaskTool.execute(
			{ id: runId, reason: 'answer already in hand' },
			h.context,
		)
		expect(stopped.success).toBe(true)
		expect(stopped.output).toContain('Reason noted: answer already in hand')
		expect(stopped.output).toContain(`Stop requested for workflow run ${runId}`)
		expect(stopped.output).toContain('Acceptance is not proof')
		expect(stopped.output).toContain('resumeFromRunId')
		expect(stopped.data).toMatchObject({
			run_id: runId,
			status: 'stop_requested',
			reason: 'answer already in hand',
		})

		await h.untilEnded()
		expect(h.ended[0]?.view.status).toBe('stopped')
		expect(h.gate.waiting()).toBe(0)
		// "three" never reached a model; "two" was cut off before it answered.
		expect(h.prompts).toEqual(['one'])

		h.gate.open()
		const resumed = await h.start({ script: STAGED, resumeFromRunId: runId })
		expect(resumed.success).toBe(true)
		await h.untilEnded(2)
		expect(h.ended[1]?.view.status).toBe('completed')
		// "one" came from the saved results, only the rest ran.
		expect(h.prompts).toEqual(['one', 'two', 'three'])
		expect(h.ended[1]?.view.result).toEqual(['ok:one', 'ok:two', 'ok:three'])
	})

	it('says already ended for a run that finished, and stops nothing', async () => {
		const h = await make()
		const runId = runIdOf(await h.start({ script: STAGED }))
		await h.untilEnded()
		const again = await h.runtime.stopTaskTool.execute({ id: runId }, h.context)
		expect(again.success).toBe(true)
		expect(again.output).toContain('already ended')
		expect(again.data).toMatchObject({ run_id: runId, status: 'already_ended' })
	})

	it('answers a run id nobody started as unknown, and a run of another conversation too', async () => {
		const h = await make({ held: true })
		const none = await h.runtime.stopTaskTool.execute({ id: 'wzzzzzzzz' }, h.context)
		expect(none.success).toBe(false)
		expect(none.error).toContain('No workflow run wzzzzzzzz')
	})
})

describe('stop_task on an agent task', () => {
	it('stops one agent by task id and leaves its sibling, then says already ended', async () => {
		const h = await make({ held: true })
		await h.start({
			script: `export const meta = { name: 'two', description: 'Two', phases: [{ title: 'Go' }] }
return await parallel([1, 2].map((n) => () => agent('p' + n, { label: 'g' + n, phase: 'Go' })))`,
		})
		await h.until(() => h.gate.waiting() === 2)
		const list = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
		const id = list.tasks[0].task_id
		const stopped = await h.runtime.stopTaskTool.execute({ id, reason: 'not needed' }, h.context)
		expect(stopped.success).toBe(true)
		expect(stopped.data).toMatchObject({
			task_id: id,
			status: 'stop_requested',
			reason: 'not needed',
		})
		await h.until(() => h.gate.waiting() === 1)
		const again = await h.runtime.stopTaskTool.execute({ id }, h.context)
		expect(again.success).toBe(true)
		expect(again.output).toMatch(/already (ended|stopping)/)
	})

	it('answers an unknown task as an error that names the id', async () => {
		const h = await make({ held: true })
		const result = await h.runtime.stopTaskTool.execute({ id: 'no-such-agent' }, h.context)
		expect(result.success).toBe(false)
		expect(result.error).toContain('no-such-agent')
	})
})

describe('the words of stop_task', () => {
	it('is one tool for agents and runs, points at job for shell work, and says when to stop', () => {
		expect(STOP_TASK_DESCRIPTION).toContain('agent task (by task ID or name) or a workflow run')
		expect(STOP_TASK_DESCRIPTION).toContain('already ended')
		expect(STOP_TASK_DESCRIPTION).toContain('Acceptance is not proof of termination')
		expect(STOP_TASK_DESCRIPTION).toContain('job tool (kill)')
		expect(STOP_WORK_GUIDANCE).toBe(
			'Background work you started is yours to end once it no longer serves the task: stop it when the person changed course, when a result already in hand answers the question, or when an earlier stage failed so the rest is pointless. Do not stop work that is only slow; a task agent_task_list labels stalled or dead is a candidate. Say in one sentence what you stopped and why.',
		)
	})

	it('is the only stop tool the runtime offers', async () => {
		const h = await make()
		expect(h.runtime.stopTaskTool.name).toBe('stop_task')
		expect(Object.keys(h.runtime)).not.toContain('cancelAgentTool')
	})
})

describe('the texts that tell the model it may stop work', () => {
	it('the Agent description says a finished agent is resumed, that a background agent is still running, and when work may end', async () => {
		const h = await make()
		const text = h.runtime.agentTool.description
		expect(text).toContain(
			'keep the child work unless the operator cancels it or the work is no longer needed',
		)
		expect(text).not.toContain('unless they ask to cancel or change it')
		expect(text).toContain(
			'A finished agent is not gone: send_message to it resumes it with its context, which is better than starting a new agent for a follow-up.',
		)
		expect(text).toContain(
			'A background agent keeps running after the call returns: say so in one sentence.',
		)
		expect(text).toContain('stop_task to end one you started that no longer serves the task')
		// The full wording lives in the stop_task description only.
		expect(text).not.toContain(STOP_WORK_GUIDANCE)
		expect(text).not.toContain('cancel_agent')
	})

	it('the launch receipt names the stop path and what a stop keeps', () => {
		const text = launchedText({ runId: 'wabcd1234', name: 'audit' })
		expect(text).toContain(
			'If the run stops serving the task (the person changed course, or what it would return no longer matters), end it with stop_task and this run id; what its agents already finished is kept for a later resume.',
		)
	})

	it('the workflow description points at stop_task for ending a run', () => {
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain(
			'stop_task with the run id ends a run that no longer serves the task, not one that is only slow; what its agents already finished is kept, so resumeFromRunId continues it later.',
		)
	})

	it('every hypermode reminder says more agents are not a goal', () => {
		const first = hypermodeReminders({
			messages: [createUserMessage('go')],
			on: true,
			toolListed: true,
		})
		const noTool = hypermodeReminders({
			messages: [createUserMessage('go')],
			on: true,
			toolListed: false,
		})
		expect(first.join('\n')).toContain(
			'More agents are not a goal: stop a run with stop_task when its result can no longer change your answer.',
		)
		expect(noTool.join('\n')).toContain(
			'More agents are not a goal: stop an agent with stop_task when its result can no longer change your answer.',
		)
	})
})
