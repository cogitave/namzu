/**
 * The screen a rail row opens has no header of its own, so what the agent
 * wrote, was sent and had cached is one muted line above its transcript, from
 * 110 columns. The /workflows list says the written number when every agent
 * is still in this process, and the journal's cumulative one otherwise.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
	type SubagentActivity,
	SubagentActivityMonitor,
} from '../../integrations/subagents/activity.js'
import { type WorkflowRunView, initialRunView } from '../../integrations/workflows/view.js'
import { AgentView, agentViewUsageLine, maxAgentViewTailOffset } from '../AgentExplorer.js'
import { workflowRunOption } from '../App.js'
import { type Screen, renderToScreen } from './support/screen.js'

function agentWith(usage: Partial<SubagentActivity>): SubagentActivity {
	const monitor = new SubagentActivityMonitor()
	monitor.begin({ agentId: 'explore', description: 'Map', prompt: 'p' })
	const [agent] = monitor.getSnapshot()
	if (!agent) throw new Error('no agent')
	return { ...agent, ...usage }
}

const USED = {
	outputTokens: 6_200,
	sentTokens: 1_170_000,
	cachedTokens: 912_400,
	tokens: 1_176_200,
}

describe('the usage line of a viewed agent', () => {
	const screens: Screen[] = []
	afterEach(async () => {
		for (const screen of screens.splice(0)) await screen.unmount()
	})

	it('names wrote, sent and cached from 110 columns, and nothing before usage arrives', async () => {
		expect(agentViewUsageLine(agentWith(USED), 128)).toBe('wrote 6.2k · sent 1.17M (912.4k cached)')
		expect(agentViewUsageLine(agentWith({}), 128)).toBeUndefined()
		const screen = await renderToScreen(
			<AgentView agent={agentWith(USED)} tailOffset={0} pageRows={8} terminalColumns={128} />,
			{ cols: 130, rows: 12 },
		)
		screens.push(screen)
		const lines = screen.viewport()
		expect(lines.some((line) => line.includes('wrote 6.2k · sent 1.17M (912.4k cached)'))).toBe(
			true,
		)
	})

	it('sits on the last row of the page, against the composer, under a long transcript', async () => {
		const transcript = Array.from({ length: 18 }, (_, index) => ({
			id: `a${index}`,
			kind: 'assistant' as const,
			text: `line ${index}`,
		}))
		const screen = await renderToScreen(
			<AgentView
				agent={agentWith({ ...USED, transcript })}
				tailOffset={0}
				pageRows={32}
				terminalColumns={128}
			/>,
			{ cols: 130, rows: 40 },
		)
		screens.push(screen)
		const lines = screen.viewport()
		const last = lines.reduce((at, line, index) => (line.trim() !== '' ? index : at), -1)
		expect(lines[last]).toContain('wrote 6.2k · sent 1.17M (912.4k cached)')
		expect(lines[last - 1]).toContain('line 17')
	})

	it('is left to the rail row on a narrow terminal', async () => {
		expect(agentViewUsageLine(agentWith(USED), 90)).toBeUndefined()
		const screen = await renderToScreen(
			<AgentView agent={agentWith(USED)} tailOffset={0} pageRows={8} terminalColumns={90} />,
			{ cols: 92, rows: 12 },
		)
		screens.push(screen)
		expect(screen.viewport().join('\n')).not.toContain('wrote')
	})

	it('takes one row of the page, and the scroll limit knows it', () => {
		const transcript = Array.from({ length: 30 }, (_, index) => ({
			id: `a${index}`,
			kind: 'assistant' as const,
			text: `line ${index}`,
		}))
		expect(maxAgentViewTailOffset(agentWith({ ...USED, transcript }), 8, 128)).toBe(
			maxAgentViewTailOffset(agentWith({ transcript }), 8, 128) + 1,
		)
	})
})

describe('a /workflows row', () => {
	const run: WorkflowRunView = {
		...initialRunView({ runId: 'r1', name: 'scan', description: '', phases: [], at: 1_000 }),
		status: 'completed',
		endedAt: 2_000,
		agents: [
			{ index: 1, label: 'a', status: 'done', queuedAt: 1_000, tokens: 1_000_000, toolCalls: 3 },
			{ index: 2, label: 'b', status: 'done', queuedAt: 1_000, tokens: 400_000, toolCalls: 2 },
		],
	} as WorkflowRunView
	const live = (outputTokens: number): SubagentActivity => ({
		...agentWith({ outputTokens }),
		workflowRunId: 'r1',
	})

	it('says what the agents wrote when every agent that spent is still here', () => {
		const text = workflowRunOption(run, [live(2_000), live(500)]).description
		expect(text).toContain('2.5k tokens written')
		expect(text).not.toContain('in all')
	})

	it('falls back to the cumulative number, labelled, for a run only the journal knows', () => {
		expect(workflowRunOption(run, []).description).toContain('1.40M tokens in all')
		// One agent live, one only in the journal: a written figure would undercount.
		expect(workflowRunOption(run, [live(2_000)]).description).toContain('1.40M tokens in all')
	})
})
