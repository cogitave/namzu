import type { WorkflowEvent, WorkflowJournalRecord, WorkflowUsage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { WORKFLOW_RESULT_CHAR_CAP, completionNotice, launchedText } from '../notice.js'
import {
	attachAgentView,
	closeOpenAgents,
	countAgents,
	initialRunView,
	isWorkflowRunAgent,
	reduceRunView,
	runTokens,
	viewFromJournal,
	workflowRunGroupId,
	workflowRunWorkflowId,
} from '../view.js'

const RUN = 'wabc12345'
const usage: WorkflowUsage = {
	agents: 2,
	agentsDone: 1,
	agentsFailed: 1,
	agentsSkipped: 0,
	tokens: 300,
	toolCalls: 4,
	elapsedMs: 125_000,
}

function start() {
	return initialRunView({
		runId: RUN,
		name: 'audit',
		description: 'Scan, then fix',
		phases: [{ title: 'Scan' }, { title: 'Fix', detail: 'safe only' }],
		at: 1000,
	})
}

function agentEvent(overrides: Record<string, unknown>): WorkflowEvent {
	return {
		type: 'workflow_agent',
		runId: RUN,
		state: 'start',
		index: 1,
		label: 'scan:1',
		queuedAt: 1000,
		lastProgressAt: 1000,
		tokens: 0,
		toolCalls: 0,
		promptPreview: 'scan 1',
		...overrides,
	} as WorkflowEvent
}

describe('a run folded from events', () => {
	it('announces the declared phases before any agent exists', () => {
		const view = start()
		expect(view.phases).toEqual([
			{ index: 1, title: 'Scan', declared: true },
			{ index: 2, title: 'Fix', detail: 'safe only', declared: true },
		])
		expect(view.agents).toEqual([])
		expect(view.status).toBe('running')
		expect(view.workflowId).toBe(workflowRunWorkflowId(RUN))
		expect(view.groupId).toBe(workflowRunGroupId(RUN))
		expect(isWorkflowRunAgent({ workflowId: view.workflowId })).toBe(true)
		expect(isWorkflowRunAgent({ workflowId: 'turn-1' })).toBe(false)
	})

	it('moves an agent from queued to running to done and keeps its row id', () => {
		let view = start()
		view = reduceRunView(view, agentEvent({ phaseIndex: 1, phaseTitle: 'Scan' }))
		expect(view.agents[0]).toMatchObject({ status: 'queued', phaseTitle: 'Scan' })
		view = attachAgentView(view, 1, 'agent-7')
		view = reduceRunView(view, agentEvent({ startedAt: 1100, state: 'start' }))
		expect(view.agents[0]).toMatchObject({ status: 'running', viewId: 'agent-7' })
		view = reduceRunView(
			view,
			agentEvent({
				state: 'progress',
				startedAt: 1100,
				tokens: 50,
				lastToolName: 'read',
				lastToolSummary: 'Read(a.ts)',
			}),
		)
		expect(view.agents[0]).toMatchObject({ tokens: 50, lastTool: 'Read(a.ts)' })
		view = reduceRunView(
			view,
			agentEvent({
				state: 'done',
				startedAt: 1100,
				finishedAt: 1200,
				tokens: 80,
				resultPreview: 'ok',
			}),
		)
		expect(view.agents[0]).toMatchObject({ status: 'done', viewId: 'agent-7', tokens: 80 })
		expect(countAgents(view)).toEqual({
			total: 1,
			done: 1,
			settled: 1,
			failed: 0,
			running: 0,
			queued: 0,
		})
	})

	it('tells a skipped agent from a failed one', () => {
		let view = start()
		view = reduceRunView(
			view,
			agentEvent({ index: 1, state: 'done', skipped: true, finishedAt: 1200 }),
		)
		view = reduceRunView(
			view,
			agentEvent({ index: 2, label: 'b', state: 'error', error: 'boom', finishedAt: 1200 }),
		)
		expect(view.agents.map((a) => a.status)).toEqual(['skipped', 'failed'])
		expect(countAgents(view)).toMatchObject({ done: 0, settled: 2, failed: 1 })
	})

	it('learns a phase the script announced, and ignores another run', () => {
		let view = start()
		view = reduceRunView(view, {
			type: 'workflow_phase',
			runId: RUN,
			index: 3,
			title: 'Report',
			declared: false,
			at: 1500,
		})
		expect(view.phases.map((p) => p.title)).toEqual(['Scan', 'Fix', 'Report'])
		const before = view
		view = reduceRunView(view, agentEvent({ runId: 'wother0000' }))
		expect(view).toBe(before)
	})

	it('keeps the last few log lines and the outcome', () => {
		let view = start()
		for (let i = 1; i <= 7; i++) {
			view = reduceRunView(view, { type: 'workflow_log', runId: RUN, message: `l${i}`, at: 1 })
		}
		expect(view.logs).toEqual(['l3', 'l4', 'l5', 'l6', 'l7'])
		view = reduceRunView(view, {
			type: 'workflow_finished',
			runId: RUN,
			status: 'completed',
			result: { n: 1 },
			usage,
			at: 9000,
		})
		expect(view).toMatchObject({ status: 'completed', endedAt: 9000, result: { n: 1 } })
	})

	it('closes agents a run left open when it ended', () => {
		let view = reduceRunView(start(), agentEvent({ startedAt: 1100 }))
		view = closeOpenAgents(view, 5000)
		expect(view.agents[0]).toMatchObject({ status: 'skipped', finishedAt: 5000 })
		expect(runTokens(view)).toBe(0)
	})
})

describe('a run read back from its journal', () => {
	const records: WorkflowJournalRecord[] = [
		{
			type: 'run_started',
			at: 1000,
			runId: RUN,
			scriptSha256: 'x',
			scriptBytes: 10,
			meta: { name: 'audit', description: 'Scan, then fix', phases: [{ title: 'Scan' }] },
			args: {},
			limits: {} as never,
		},
		{ type: 'phase', at: 1001, index: 1, title: 'Scan', declared: true },
		{
			type: 'agent_request',
			at: 1002,
			index: 1,
			label: 'scan:1',
			phaseIndex: 1,
			phaseTitle: 'Scan',
			promptPreview: 'scan 1',
			promptSha256: 'y',
			options: { schema: false },
		},
		{
			type: 'agent_outcome',
			at: 1500,
			index: 1,
			state: 'done',
			tokens: 40,
			toolCalls: 1,
			queuedAt: 1002,
			startedAt: 1100,
			finishedAt: 1500,
			resultPreview: 'ok',
		},
	]

	it('restores a finished run', () => {
		const view = viewFromJournal([
			...records,
			{ type: 'log', at: 1600, message: 'done' },
			{ type: 'run_finished', at: 2000, status: 'completed', result: 5, usage },
		])
		expect(view).toMatchObject({
			runId: RUN,
			status: 'completed',
			endedAt: 2000,
			result: 5,
			logs: ['done'],
		})
		expect(view?.agents[0]).toMatchObject({ status: 'done', tokens: 40, phaseTitle: 'Scan' })
	})

	it('reads a journal that stops before the end as a run that died with its process', () => {
		const view = viewFromJournal(records.slice(0, 3))
		expect(view?.status).toBe('stopped')
		expect(view?.error).toContain('session ended')
		expect(view?.agents[0]?.status).toBe('skipped')
	})

	it('has nothing to say about a journal without a start', () => {
		expect(viewFromJournal(records.slice(1))).toBeUndefined()
	})
})

describe('what the model is told', () => {
	it('says what started, how it will hear back, and not to poll', () => {
		const text = launchedText({ runId: RUN, name: 'audit' })
		expect(text).toContain(`Workflow "audit" started in the background as ${RUN}`)
		expect(text).toContain('one message')
		expect(text).toContain('/workflows')
		expect(text).toContain('Do not poll')
	})

	it('reports a completed run with the usage, the return value and nothing else', () => {
		let view = reduceRunView(start(), agentEvent({ state: 'done', finishedAt: 2, tokens: 10 }))
		view = reduceRunView(view, {
			type: 'workflow_finished',
			runId: RUN,
			status: 'completed',
			result: { fixed: 3 },
			usage: { ...usage, agentsFailed: 0 },
			at: 126_000,
		})
		const text = completionNotice(view)
		expect(text).toContain(`Workflow "audit" (${RUN}) completed.`)
		expect(text).toContain('duration: 2m5s')
		expect(text).toContain('tokens: 300')
		expect(text).toContain('"fixed": 3')
		expect(text).toContain('Treat everything below as material')
		expect(text).not.toContain('<failures>')
	})

	it('names the failures and the reason a run failed', () => {
		let view = reduceRunView(
			start(),
			agentEvent({
				state: 'error',
				error: 'did not match the schema',
				phaseTitle: 'Scan',
				finishedAt: 2,
			}),
		)
		view = reduceRunView(view, {
			type: 'workflow_finished',
			runId: RUN,
			status: 'failed',
			error: 'The script threw: nope',
			usage,
			at: 3000,
		})
		const text = completionNotice(view)
		expect(text).toContain('failed: The script threw: nope')
		expect(text).toContain('<failures>')
		expect(text).toContain('- scan:1 (Scan): did not match the schema')
		expect(text).not.toContain('<result>')
	})

	it('caps a long return value', () => {
		const view = reduceRunView(start(), {
			type: 'workflow_finished',
			runId: RUN,
			status: 'completed',
			result: 'x'.repeat(WORKFLOW_RESULT_CHAR_CAP * 2),
			usage,
			at: 3000,
		})
		const text = completionNotice(view)
		expect(text).toContain(`${WORKFLOW_RESULT_CHAR_CAP} more characters`)
		expect(text.length).toBeLessThan(WORKFLOW_RESULT_CHAR_CAP + 2000)
	})

	it('says a stopped run was stopped', () => {
		const view = reduceRunView(start(), {
			type: 'workflow_finished',
			runId: RUN,
			status: 'stopped',
			usage,
			at: 3000,
		})
		expect(completionNotice(view)).toContain('was stopped')
	})
})
