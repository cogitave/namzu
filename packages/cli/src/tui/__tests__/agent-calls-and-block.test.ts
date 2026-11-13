import { describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { agentCalls, callDetailLines, callWords, liveCalls } from '../agent-calls.js'
import { agentDetailLines, waitedOnBlock } from '../agent-transcript-rows.js'
import { callBlockExtraRows, liveGroups } from '../background-agents.js'
import {
	agentCompletionRows,
	blockedAgents,
	holdsForBatch,
	settledBatchRows,
	withSavedAgentRows,
} from '../restored-rows.js'
import type { TranscriptMessage } from '../types.js'

type ToolStatus = 'working' | 'completed' | 'failed'

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
		startedAt: 1_000,
		transcript: [],
		...input,
	} as SubagentActivity
}

function calls(...items: [string, ToolStatus][]): SubagentActivity['transcript'] {
	return items.map(([text, status], index) => ({
		id: `t${index}`,
		kind: 'tool' as const,
		text,
		status,
	}))
}

const never = () => false

describe('how a call is worded', () => {
	it('names the tool in plain words and what it acts on', () => {
		expect(callWords('Read(src/a.ts)')).toBe('Read src/a.ts')
		expect(callWords('Bash(npm test)')).toBe('Run npm test')
		expect(callWords('Grep(parse)')).toBe('Search parse')
		expect(callWords('mcp__docs__lookup(x)')).toBe('docs lookup x')
		expect(callWords('some_new_tool()')).toBe('some new tool')
	})
})

describe('the last calls under a waited-on agent', () => {
	const working = agent({
		viewId: 'a',
		toolCalls: 8,
		transcript: calls(
			['Read(a.ts)', 'completed'],
			['Grep(x)', 'completed'],
			['Bash(npm test)', 'failed'],
			['Read(b.ts)', 'completed'],
			['Edit(b.ts)', 'working'],
		),
	})

	it('keeps the last three, marks the running and the failed one, and counts the rest', () => {
		expect(liveCalls(working, '↓ to manage')).toEqual({
			earlier: '… 5 earlier calls not shown (↓ to manage)',
			rows: ['✗ Run npm test', '✓ Read b.ts', '◌ Edit b.ts'],
		})
	})

	it('has no calls before the first one, and no earlier line when all are shown', () => {
		expect(liveCalls(agent({ viewId: 'a' }), 'x')).toBeUndefined()
		const few = agent({
			viewId: 'a',
			toolCalls: 2,
			transcript: calls(['Read(a)', 'completed'], ['Read(b)', 'working']),
		})
		expect(liveCalls(few, 'x')).toEqual({ rows: ['✓ Read a', '◌ Read b'] })
	})

	it('is drawn for one agent only, and only when there is room', () => {
		const one = liveGroups([working], never, true)
		expect(one[0]?.agents[0]?.calls?.rows).toHaveLength(3)
		// earlier line + three calls replace the one status row
		expect(callBlockExtraRows(one)).toBe(3)
		expect(liveGroups([working], never, false)[0]?.agents[0]?.calls).toBeUndefined()
		const two = liveGroups([working, agent({ viewId: 'b' })], never, true)
		expect(two[0]?.agents.every((entry) => entry.calls === undefined)).toBe(true)
		expect(callBlockExtraRows(two)).toBe(0)
		// two batches of one agent each are still two agents
		const batches = liveGroups(
			[working, agent({ viewId: 'c', batchId: 'batch-2', startedAt: 2_000 })],
			never,
			true,
		)
		expect(batches.every((group) => group.agents.every((entry) => entry.calls === undefined))).toBe(
			true,
		)
	})

	it('keeps Initializing before the first call', () => {
		const group = liveGroups([agent({ viewId: 'a' })], never, true)[0]
		expect(group?.agents[0]).toEqual({ line: 'a · 0 tool uses', status: 'Initializing…' })
	})
})

describe('the calls behind a finished agent', () => {
	it('lists each call with its mark and says how many were not retained', () => {
		const done = agent({
			viewId: 'a',
			status: 'completed',
			toolCalls: 130,
			transcript: calls(['Read(a)', 'completed'], ['Bash(x)', 'failed']),
		})
		expect(callDetailLines(done)).toEqual([
			'128 earlier calls are not retained.',
			'✓ Read a',
			'✗ Run x',
		])
		expect(agentCalls(done)).toHaveLength(2)
	})

	it('says the list is gone instead of showing nothing', () => {
		const done = agent({ viewId: 'a', status: 'completed', toolCalls: 3 })
		expect(callDetailLines(done)).toEqual([
			'This agent made 3 calls; the list is not available any more.',
		])
		expect(callDetailLines(agent({ viewId: 'a', status: 'completed', toolCalls: 0 }))).toEqual([])
	})

	it('puts the calls before the answer', () => {
		const done = agent({
			viewId: 'a',
			status: 'completed',
			toolCalls: 1,
			transcript: [
				...calls(['Read(a)', 'completed']),
				{ id: 'x', kind: 'assistant', text: 'It is 4.' },
			],
		})
		expect(agentDetailLines(done)).toEqual(['Calls', '✓ Read a', '', 'Answer', 'It is 4.'])
	})

	it('gives a waited-on agent a Done row that opens to them', () => {
		const done = agent({
			viewId: 'a',
			status: 'completed',
			toolCalls: 1,
			completedAt: 9_000,
			transcript: calls(['Read(a)', 'completed']),
		})
		const rows = agentCompletionRows(done)
		expect(rows.map((row) => row.content)).toEqual([
			'general-purpose (a)',
			'Done (1 tool use · 0 tokens · 8s)',
		])
		expect(rows[1]?.detail).toEqual(['Calls', '✓ Read a'])
		expect(rows[1]?.meta).toBeDefined()
	})
})

describe('a batch of waited-on agents that all finished', () => {
	const members = [
		agent({
			viewId: 'a',
			description: 'Count a',
			status: 'completed',
			toolCalls: 4,
			tokens: 8_100,
			startedAt: 1_000,
			completedAt: 9_000,
		}),
		agent({
			viewId: 'b',
			description: 'Count b',
			status: 'completed',
			toolCalls: 2,
			tokens: 3_000,
			startedAt: 1_100,
			completedAt: 6_000,
		}),
		agent({
			viewId: 'c',
			description: 'Count c',
			status: 'completed',
			toolCalls: 1,
			tokens: 500,
			startedAt: 1_200,
			completedAt: 3_000,
		}),
	]

	it('ends as one block: a header with the totals, then a line per agent', () => {
		expect(waitedOnBlock(members).content).toBe(
			[
				'3 agents finished · 7 tool uses · 11.6k tokens · 8s',
				'├ general-purpose (Count a) · 4 tool uses · 8.1k tokens · 8s',
				'├ general-purpose (Count b) · 2 tool uses · 3.0k tokens · 4s',
				'└ general-purpose (Count c) · 1 tool use · 500 tokens · 1s',
			].join('\n'),
		)
	})

	it('replaces the receipt and the per-agent rows', () => {
		const rows = settledBatchRows(members)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content.split('\n')[0]).toContain('3 agents finished')
		expect(rows[0]?.detail?.[0]).toBe('general-purpose (Count a)')
	})

	it('keeps a failed or stopped agent as its own row, outside the block', () => {
		const mixed = [
			...members,
			agent({ viewId: 'd', status: 'failed', startedAt: 1_300, completedAt: 2_000 }),
		]
		expect(blockedAgents(mixed).map((entry) => entry.viewId)).toEqual(['a', 'b', 'c'])
		const rows = settledBatchRows(mixed)
		expect(rows).toHaveLength(2)
		expect(rows[0]?.content.split('\n')[0]).toBe('4 agents: 3 finished, 1 failed')
		expect(rows[1]?.content.split('\n')[0]).toContain('3 agents finished')
		expect(agentCompletionRows(mixed[3] as SubagentActivity)[0]?.content).toContain('failed')
	})

	it('is not a block for one finished agent, for a running batch or for background agents', () => {
		expect(blockedAgents([members[0] as SubagentActivity])).toEqual([])
		expect(blockedAgents([...members, agent({ viewId: 'r' })])).toEqual([])
		expect(blockedAgents(members.map((entry) => ({ ...entry, background: true })))).toEqual([])
		const oneLeft = [members[0] as SubagentActivity, agent({ viewId: 'x', status: 'failed' })]
		expect(blockedAgents(oneLeft)).toEqual([])
	})

	it('holds an early finisher for the batch, and never with tui.agentCalls off', () => {
		const early = members[0] as SubagentActivity
		const running = agent({ viewId: 'r' })
		const batch = [early, running]
		expect(holdsForBatch(early, batch, true)).toBe(true)
		expect(holdsForBatch(early, batch, true, false)).toBe(false)
		expect(holdsForBatch(early, batch, false)).toBe(false)
		expect(holdsForBatch(early, [early], true)).toBe(false)
		expect(holdsForBatch({ ...early, status: 'failed' }, batch, true)).toBe(false)
	})

	it('is switched off by tui.agentCalls: a receipt and two rows per agent, no calls behind them', () => {
		expect(blockedAgents(members, false)).toEqual([])
		expect(settledBatchRows(members, false).map((row) => row.content.split('\n')[0])).toEqual([
			'3 agents finished',
		])
		const done = agentCompletionRows(
			{ ...(members[0] as SubagentActivity), toolCalls: 3 },
			undefined,
			false,
		)
		expect(done[1]?.detail).toBeUndefined()
	})

	it('is the same row in a reopened conversation as in the live run', () => {
		const saved = members.map((entry) => ({ ...entry, replayed: true }))
		const marker: TranscriptMessage = {
			id: 'm0',
			role: 'assistant',
			content: 'On it.',
			agentTurnId: 'turn-1',
		}
		let counter = 0
		const placed = withSavedAgentRows([marker], saved, () => `r${++counter}`)
		// the live run writes exactly the batch's rows, then nothing per agent
		const live = [...settledBatchRows(saved)]
		expect(
			placed
				.slice(1)
				.map((row) => ({ content: row.content, detail: row.detail, glyph: row.glyph })),
		).toEqual(live.map((row) => ({ content: row.content, detail: row.detail, glyph: row.glyph })))
	})
})
