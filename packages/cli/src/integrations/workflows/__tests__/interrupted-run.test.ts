/**
 * A run the program itself cuts short (the session ends, the person moves to
 * another conversation) is told to the model the next time the conversation is
 * opened, with its run id and how to resume it. A run that ended on its own is
 * not announced again.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FileWorkflowJournal } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { CONTINUE_RUN_GUIDANCE, STOP_TASK_DESCRIPTION } from '../../subagents/stop-guidance.js'
import { WORKFLOW_TOOL_DESCRIPTION } from '../offering.js'
import { markOrphanNoticesDelivered, recoverUnfinishedWorkflows } from '../orphans.js'
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

const STAGED = `export const meta = { name: 'staged', description: 'One, then two', phases: [{ title: 'Go' }] }
const first = await agent('one', { label: 'first', phase: 'Go' })
const second = await agent('two', { label: 'second', phase: 'Go' })
return [first, second]`

function runIdOf(result: { output: string }): string {
	const found = /\b(w[0-9a-z]{8})\b/.exec(result.output)
	if (!found) throw new Error(`no run id in ${result.output}`)
	return found[1] as string
}

/** A run whose first agent finished and whose second is held at the model gate. */
async function halfDoneRun() {
	const h = await make({ held: true })
	const runId = runIdOf(await h.start({ script: STAGED }))
	await h.until(() => h.gate.waiting() === 1)
	h.gate.release()
	await h.until(() => h.prompts.includes('one') && h.gate.waiting() === 1)
	return { h, runId }
}

describe('a run cut short by the program', () => {
	it('is reported at the next open with its id and the resume call, once', async () => {
		const { h, runId } = await halfDoneRun()
		h.host.registry.close()
		await h.untilEnded()

		const [notice, ...rest] = await recoverUnfinishedWorkflows({
			runsDirectory: h.runs,
			liveRunIds: new Set(),
		})
		expect(rest).toEqual([])
		expect(notice?.runId).toBe(runId)
		expect(notice?.text).toContain(`run ${runId}) was cut short`)
		expect(notice?.text).toContain('the session ended')
		expect(notice?.text).toContain('Nobody asked to stop it')
		expect(notice?.text).toContain('1 agent had finished')
		expect(notice?.text).toContain(`resumeFromRunId: "${runId}"`)
		expect(notice?.text).toContain('rather than redoing its work by hand')
		expect(notice?.text).toContain('search_tools')

		// Until a turn has handed it over, it is offered again; afterwards, never.
		expect(
			await recoverUnfinishedWorkflows({ runsDirectory: h.runs, liveRunIds: new Set() }),
		).toHaveLength(1)
		await markOrphanNoticesDelivered(h.runs, [runId])
		expect(
			await recoverUnfinishedWorkflows({ runsDirectory: h.runs, liveRunIds: new Set() }),
		).toEqual([])
	})

	it('names a conversation change as the cause', async () => {
		const { h, runId } = await halfDoneRun()
		h.host.registry.reset()
		await h.until(() => h.ended.length === 1)
		const [notice] = await recoverUnfinishedWorkflows({
			runsDirectory: h.runs,
			liveRunIds: new Set(),
		})
		expect(notice?.runId).toBe(runId)
		expect(notice?.text).toContain('moved to another conversation')
	})

	it('is not announced when the run had ended on its own', async () => {
		const h = await make()
		runIdOf(await h.start({ script: STAGED }))
		await h.untilEnded()
		h.host.registry.close()
		expect(
			await recoverUnfinishedWorkflows({ runsDirectory: h.runs, liveRunIds: new Set() }),
		).toEqual([])
	})

	it('is not announced when the person stopped it: the end was told in the conversation', async () => {
		const { h, runId } = await halfDoneRun()
		expect(h.host.registry.stop(runId)).toBe(true)
		await h.untilEnded()
		h.host.registry.close()
		expect(
			await recoverUnfinishedWorkflows({ runsDirectory: h.runs, liveRunIds: new Set() }),
		).toEqual([])
	})

	it('tells the model a journal that cannot be resumed here must be started again', async () => {
		const { h, runId } = await halfDoneRun()
		h.host.registry.close()
		await h.untilEnded()
		writeFileSync(join(h.runs, runId, 'workflow', 'journal.jsonl'), 'not a journal\n')
		const [notice] = await recoverUnfinishedWorkflows({
			runsDirectory: h.runs,
			liveRunIds: new Set(),
		})
		// With nothing in the journal that can be trusted, the stored notice still reaches the model.
		expect(notice?.runId).toBe(runId)
		expect(notice?.text).toContain('cannot be read or resumed on this machine')
		expect(notice?.text).not.toContain('resumeFromRunId: ')
	})

	it('is not announced again once a later pass has finished the run', async () => {
		const { h, runId } = await halfDoneRun()
		h.host.registry.close()
		await h.untilEnded()
		const journal = new FileWorkflowJournal(join(h.runs, runId, 'workflow'), { runId })
		await journal.append({
			type: 'run_started',
			at: Date.now(),
			runId,
			scriptSha256: 's',
			scriptBytes: 1,
			meta: { name: 'staged', description: 'd', phases: [] },
			args: {},
			limits: {} as never,
			resume: { pass: 2, previousFinish: 'stopped', scriptSha256Changed: false },
		})
		await journal.append({
			type: 'run_finished',
			at: Date.now(),
			status: 'completed',
			usage: {
				agents: 2,
				agentsDone: 2,
				agentsFailed: 0,
				agentsSkipped: 0,
				tokens: 0,
				toolCalls: 0,
				elapsedMs: 0,
			},
		})
		expect(
			await recoverUnfinishedWorkflows({ runsDirectory: h.runs, liveRunIds: new Set() }),
		).toEqual([])
	})
})

describe('guidance for "continue"', () => {
	it('is in the workflow and stop_task descriptions the model reads', () => {
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain(CONTINUE_RUN_GUIDANCE)
		expect(STOP_TASK_DESCRIPTION).toContain(CONTINUE_RUN_GUIDANCE)
		// Resuming is an exception to the opt-in rule, and the tool may be deferred.
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain(
			'asked to continue or resume a run of this conversation',
		)
		expect(CONTINUE_RUN_GUIDANCE).toContain('resumeFromRunId')
		expect(CONTINUE_RUN_GUIDANCE).toContain(
			'instead of redoing its work by hand or starting a fresh run',
		)
		expect(CONTINUE_RUN_GUIDANCE).toContain('Say in one line that you are resuming it.')
	})
})

describe('agent_task_list for one run', () => {
	it("gives the outputs of the run's agents with run_id and include_output", async () => {
		const h = await make()
		const runId = runIdOf(await h.start({ script: STAGED }))
		await h.untilEnded()
		const read = await h.runtime.agentTaskListTool.execute(
			{ run_id: runId, include_output: true },
			h.context,
		)
		expect(read.success).toBe(true)
		const body = JSON.parse(read.output)
		expect(body.run_agents).toHaveLength(2)
		expect(body.run_agents[0]).toMatchObject({ outputAvailable: true, outputState: 'settled' })
		expect(JSON.stringify(body.run_agents)).toContain('ok:one')
		expect(body.workflows[0].run_id).toBe(runId)
	})

	it('still refuses include_output with neither a task_id nor a run_id, and says what to pass', async () => {
		const h = await make()
		const read = await h.runtime.agentTaskListTool.execute({ include_output: true }, h.context)
		expect(read.success).toBe(false)
		expect(read.error).toContain('one task_id, or a run_id')
	})

	it('says a run this session no longer holds is not running and how to continue it', async () => {
		const h = await make()
		const read = await h.runtime.agentTaskListTool.execute({ run_id: 'wabcdefgh' }, h.context)
		const body = JSON.parse(read.output)
		expect(body.workflows).toEqual([])
		expect(body.runNote).toContain('holds no run wabcdefgh now')
		expect(body.runNote).toContain('resumeFromRunId wabcdefgh')
	})

	it('names the run an unknown agent id belonged to', async () => {
		const h = await make()
		const runId = runIdOf(await h.start({ script: STAGED }))
		await h.untilEnded()
		const viewId = h.runtime.activity.getSnapshot()[0]?.viewId as string
		h.runtime.activity.reset()
		const read = await h.runtime.agentTaskListTool.execute({ task_id: viewId }, h.context)
		expect(read.success).toBe(false)
		expect(read.error).toContain(`belonged to workflow run ${runId}`)
		expect(read.error).toContain(`resumeFromRunId ${runId}`)
	})
})
