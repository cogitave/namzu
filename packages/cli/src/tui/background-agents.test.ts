import { describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../integrations/subagents/activity.js'
import { launchReceipt } from './agent-transcript-rows.js'
import {
	backgroundWaitLine,
	liveGroups,
	pendingBackgroundAgents,
	runningGroup,
	stoppedByUserNote,
} from './background-agents.js'
import { agentCompletionRows } from './restored-rows.js'

function agent(input: Partial<SubagentActivity> & { viewId: string }): SubagentActivity {
	return {
		agentId: 'general-purpose',
		description: input.viewId,
		prompt: 'p',
		batchId: 'batch-1',
		workflowId: 'turn-1',
		workflowGroupId: '[]',
		phaseId: '[]',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 1,
		status: 'working',
		startedAt: 1,
		transcript: [],
		...input,
	} as SubagentActivity
}

const never = () => false

describe('the waiting line', () => {
	it('names background agents with the right plural', () => {
		expect(backgroundWaitLine(1, 0)).toBe('Waiting for 1 background agent to finish')
		expect(backgroundWaitLine(3, 0)).toBe('Waiting for 3 background agents to finish')
	})

	it('adds dynamic workflows', () => {
		expect(backgroundWaitLine(2, 1)).toBe(
			'Waiting for 2 background agents and 1 dynamic workflow to finish',
		)
		expect(backgroundWaitLine(0, 2)).toBe('Waiting for 2 dynamic workflows to finish')
	})

	it('says nothing when nothing is pending', () => {
		expect(backgroundWaitLine(0, 0)).toBeUndefined()
	})

	it('counts only running background agents that are not a workflow run', () => {
		const agents = [
			agent({ viewId: 'a', background: true }),
			agent({ viewId: 'b', background: true, status: 'completed' }),
			agent({ viewId: 'c' }),
			agent({ viewId: 'd', background: true, status: 'queued' }),
			agent({ viewId: 'e', background: true, replayed: true }),
		]
		expect(pendingBackgroundAgents(agents, never).map((entry) => entry.viewId)).toEqual(['a', 'd'])
		expect(pendingBackgroundAgents(agents, (entry) => entry.viewId === 'a')).toHaveLength(1)
	})
})

describe('the note for a stop the operator asked for', () => {
	it('is one note, whatever the count', () => {
		expect(stoppedByUserNote(['Count words'])).toBe(
			'Background agent "Count words" was stopped by the user.',
		)
		expect(stoppedByUserNote(['A', 'B'])).toBe(
			'2 background agents were stopped by the user: "A", "B".',
		)
		expect(stoppedByUserNote([])).toBeUndefined()
	})
})

describe('the live group', () => {
	it('shows a batch the turn waits on, with tool counts and the last tool', () => {
		const group = runningGroup([
			agent({
				viewId: 'a',
				description: 'Read a',
				toolCalls: 4,
				tokens: 12_100,
				latestActivity: 'Read(a.ts)',
			}),
			agent({ viewId: 'b', description: 'Read b' }),
		])
		expect(group).toEqual({
			header: 'Running 2 agents…',
			agents: [
				{ line: 'Read a · 4 tool uses · 12.1k tokens', status: 'Read(a.ts)' },
				{ line: 'Read b · 0 tool uses', status: 'Initializing…' },
			],
		})
	})

	it('is not drawn for a background batch, a finished batch or a labelled workflow', () => {
		expect(runningGroup([agent({ viewId: 'a', background: true })])).toBeUndefined()
		expect(runningGroup([agent({ viewId: 'a', status: 'completed' })])).toBeUndefined()
		expect(runningGroup([agent({ viewId: 'a', workflow: 'Release audit' })])).toBeUndefined()
		expect(liveGroups([agent({ viewId: 'a', replayed: true })], never)).toEqual([])
	})

	it('keeps batches apart', () => {
		const groups = liveGroups(
			[
				agent({ viewId: 'a', batchId: 'one' }),
				agent({ viewId: 'b', batchId: 'two', startedAt: 5 }),
			],
			never,
		)
		expect(groups.map((group) => group.header)).toEqual(['Running 1 agent…', 'Running 1 agent…'])
	})
})

describe('the receipt of a batch the turn waited on', () => {
	it('says how many finished once every member has ended', () => {
		const running = [agent({ viewId: 'a' }), agent({ viewId: 'b' })]
		expect(launchReceipt(running).content).toContain('Launched 2 agents')
		const ended = running.map((entry) => ({ ...entry, status: 'completed' as const }))
		expect(launchReceipt(ended).content.split('\n')[0]).toBe('2 agents finished')
	})

	it('keeps the manage hint for an all-background batch only', () => {
		const batch = [
			agent({ viewId: 'a', background: true }),
			agent({ viewId: 'b', background: true }),
		]
		expect(launchReceipt(batch).content.split('\n')[0]).toBe(
			'2 background agents launched (↓ to manage)',
		)
		expect(
			launchReceipt([agent({ viewId: 'a', background: true }), agent({ viewId: 'b' })]).content,
		).not.toContain('↓ to manage')
	})
})

describe('one row per completion', () => {
	const answer = {
		id: 'x:assistant',
		kind: 'assistant' as const,
		text: 'The beta branch is 719.',
	}

	it('carries the answer on the line that says the agent finished', () => {
		const rows = agentCompletionRows(
			agent({
				viewId: 'a',
				description: 'beta lookup',
				background: true,
				status: 'completed',
				completedAt: 8_001,
				transcript: [answer as never],
			}),
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			content: 'Agent "beta lookup" finished · 8s',
			detail: ['The beta branch is 719.'],
			activity: 'agent-result',
		})
	})

	it('leaves a failure as a single line with no answer to open', () => {
		const rows = agentCompletionRows(
			agent({
				viewId: 'a',
				background: true,
				status: 'failed',
				completedAt: 2,
				transcript: [answer as never],
			}),
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.detail).toBeUndefined()
	})
})
