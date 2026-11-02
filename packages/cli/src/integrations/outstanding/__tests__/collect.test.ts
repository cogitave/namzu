import { expect, it } from 'vitest'

import type { SubagentActivity } from '../../subagents/activity.js'
import { initialRunView, reduceRunView } from '../../workflows/view.js'
import { type JobFact, collectOutstanding, currentPhase } from '../collect.js'
import { outstandingLines } from '../note.js'

const T0 = 1_000_000

const job = (over: Partial<JobFact> = {}): JobFact => ({
	id: 'b1',
	command: 'npm test',
	status: 'running',
	startedAt: T0,
	alive: true,
	...over,
})

function agent(over: Partial<SubagentActivity> = {}): SubagentActivity {
	return {
		viewId: 'agent-1',
		taskId: 't1',
		agentId: 'explore',
		description: 'survey the repo',
		prompt: 'p',
		batchId: 'b',
		workflowId: 'w',
		workflowGroupId: 'g',
		phaseId: 'p',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 1,
		status: 'working',
		startedAt: T0,
		transcript: [],
		...over,
	} as SubagentActivity
}

function run(over: { agents?: Array<Partial<Parameters<typeof reduceRunView>[1]> & object> } = {}) {
	let view = initialRunView({
		runId: 'w12345678',
		name: 'audit',
		description: 'd',
		phases: [{ title: 'Scan' }, { title: 'Fix' }],
		at: T0,
	})
	const event = (
		index: number,
		state: 'queued' | 'running' | 'done',
		phaseIndex: number,
		at: number,
	) =>
		reduceRunView(view, {
			type: 'workflow_agent',
			runId: 'w12345678',
			index,
			label: `agent-${index}`,
			phaseIndex,
			phaseTitle: phaseIndex === 1 ? 'Scan' : 'Fix',
			state: state === 'done' ? 'done' : 'progress',
			queuedAt: T0,
			...(state !== 'queued' ? { startedAt: at } : {}),
			...(state === 'done' ? { finishedAt: at + 1_000, resultPreview: `result ${index}` } : {}),
			tokens: 0,
			toolCalls: 0,
			promptPreview: 'p',
		} as never)
	view = event(1, 'done', 1, T0 + 5_000)
	view = event(2, 'running', 2, T0 + 20_000)
	view = event(3, 'queued', 2, T0)
	return view
}

const lines = (facts: Parameters<typeof collectOutstanding>[0]) =>
	outstandingLines(collectOutstanding(facts))

it('judges every kind of item with the same verdict words', () => {
	const view = run()
	expect(
		lines({
			now: T0 + 60_000,
			jobs: [
				job({ lastOutputAt: T0 + 56_000, lastOutputLine: 'compiling' }),
				job({ id: 'b2', command: 'serve', alive: false }),
				job({ id: 'b3', kind: 'monitor', command: 'tail -f x', description: 'deploy log' }),
				job({ id: 'b4', status: 'exited' }),
			],
			agents: [
				agent({
					lastProgressAt: T0 + 59_000,
					transcript: [{ id: 'r', kind: 'tool', text: 'Read(a.ts)', status: 'completed' }],
				}),
				agent({ viewId: 'agent-2', taskId: 't2', description: 'slow one', status: 'queued' }),
				agent({ viewId: 'agent-3', taskId: 't3', status: 'completed' }),
				agent({ viewId: 'agent-4', taskId: 't4', workflowRunId: 'w12345678' }),
			],
			workflows: [view],
		}),
	).toEqual([
		'workflow w12345678 "audit" - waiting - last progress 40s ago - at: phase 2/2 "Fix", 1 running, 1 queued, 1 done',
		'agent t1 "survey the repo" - progressing - last progress 1s ago - at: ran Read',
		'agent t2 "slow one" - waiting on a free agent slot for 1m 00s - at: queued for a free slot',
		'job b1 "npm test" - progressing - last progress 4s ago - at: compiling',
		'job b2 "serve" - dead: gone without a result after 1m 00s, last progress 1m 00s ago',
		'monitor b3 "deploy log" - waiting - last progress 1m 00s ago',
	])
})

it('calls a silent alive job stalled and a workflow with only queued agents waiting', () => {
	const got = lines({
		now: T0 + 400_000,
		jobs: [job({ lastOutputAt: T0 + 10_000, lastOutputLine: 'still here' })],
		agents: [],
		workflows: [],
	})
	expect(got).toEqual(['job b1 "npm test" - stalled - last progress 6m 30s ago - at: still here'])
})

it('names the tool an agent has sat in past the quiet threshold, and only then', () => {
	const inTool = agent({
		lastProgressAt: T0,
		transcript: [{ id: 'r', kind: 'tool', text: 'Bash(npm test)', status: 'working' }],
	})
	expect(lines({ now: T0 + 10_000, jobs: [], agents: [inTool], workflows: [] })[0]).toContain(
		'progressing',
	)
	expect(lines({ now: T0 + 90_000, jobs: [], agents: [inTool], workflows: [] })[0]).toContain(
		'waiting on the Bash tool for 1m 30s',
	)
})

it('leaves ended work and replayed rows out, and keeps a dead one in', () => {
	expect(
		collectOutstanding({
			now: T0,
			jobs: [job({ status: 'killed' }), job({ id: 'b9', alive: false })],
			agents: [agent({ replayed: true }), agent({ viewId: 'a2', status: 'failed' })],
			workflows: [{ ...run(), status: 'completed' }],
		}).map((item) => `${item.id}:${item.verdict}`),
	).toEqual(['b9:dead'])
})

it('reports the phase of the agents that are running', () => {
	expect(currentPhase(run())).toEqual({ index: 2, total: 2, title: 'Fix' })
	expect(
		currentPhase(initialRunView({ runId: 'w1', name: 'n', description: 'd', phases: [], at: 0 })),
	).toBeUndefined()
})
