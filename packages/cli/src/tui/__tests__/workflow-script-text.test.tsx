/**
 * Text a script builds at run time (a name, a phase title, an agent label, a
 * log line) can carry control characters, direction overrides and zero-width
 * characters. Every surface that draws one shows them spelled out.
 */

import { Box } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { initialRunView } from '../../integrations/workflows/view.js'
import {
	AgentCockpit,
	AgentTaskPanel,
	AgentTranscript,
	agentWorkflows,
	runRailWorkflow,
} from '../AgentExplorer.js'
import { workflowRunOption } from '../App.js'
import { workflowNotice } from '../agent-transcript-rows.js'
import {
	buildPermissionReview,
	buildPermissionSummary,
	permissionReviewRows,
} from '../permission-review.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 1_000_000
const cp = (value: number): string => String.fromCodePoint(value)
const HOSTILE = `x${cp(0x1b)}[2Jy${cp(0x202e)}z${cp(0x200b)}w${cp(0x07)}`
const SPELLED = ['\\u{001b}', '\\u{202e}', '\\u{200b}', '\\u{0007}']
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the point of the test
const RAW = /[\u0000-\u0008\u000b-\u001f\u007f\u200b\u202a-\u202e\u2066-\u2069]/u

function expectSafe(rows: readonly string[], spelled: readonly string[] = SPELLED): void {
	const text = rows.join('\n')
	expect(text).not.toMatch(RAW)
	for (const literal of spelled) expect(text).toContain(literal)
}

const agent: SubagentActivity = {
	viewId: 'a1',
	agentId: 'general-purpose',
	description: `label ${HOSTILE}`,
	prompt: 'p',
	batchId: 'b',
	workflowId: 'wf:w1',
	workflowGroupId: 'wfrun:w1',
	phaseId: 'wfrun:w1:1',
	workflow: `name ${HOSTILE}`,
	phase: `Phase ${HOSTILE}`,
	phaseOrder: 1,
	phaseSequence: 1,
	status: 'working',
	startedAt: NOW - 5_000,
	transcript: [],
	workflowRunId: 'w1',
}

const run = {
	...initialRunView({
		runId: 'w1',
		name: `name ${HOSTILE}`,
		description: `about ${HOSTILE}`,
		phases: [{ title: `Phase ${HOSTILE}`, detail: `detail ${HOSTILE}` }],
		at: NOW - 6_000,
	}),
	logs: [`log ${HOSTILE}`],
}

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function draw(node: React.ReactNode, cols = 110, rows = 30): Promise<string[]> {
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			{node}
		</Box>,
		{ cols, rows },
	)
	return mounted.viewport()
}

describe('a script that builds text from data', () => {
	it('is spelled out in the detail screen: name, description, phase, detail, log and label', async () => {
		const phase = agentWorkflows([agent], [run])[0]?.phases[0]
		const rows = await draw(
			<AgentCockpit
				agents={[agent]}
				runs={[run]}
				selectedPhaseId={phase?.id ?? ''}
				selectedId="a1"
				focus="phases"
				terminalRows={30}
				terminalColumns={110}
			/>,
		)
		expectSafe(rows)
	})

	it('is spelled out in the list of agents', async () => {
		const phase = agentWorkflows([agent], [run])[0]?.phases[0]
		const rows = await draw(
			<AgentCockpit
				agents={[agent]}
				runs={[run]}
				selectedPhaseId={phase?.id ?? ''}
				selectedId="a1"
				focus="agents"
				terminalRows={30}
				terminalColumns={110}
			/>,
		)
		expectSafe(rows)
	})

	it('is spelled out on the rail', async () => {
		const workflow = runRailWorkflow(run, [agent])
		const rows = await draw(
			<AgentTaskPanel
				agents={[]}
				workflows={[workflow]}
				terminalRows={40}
				terminalColumns={110}
				now={NOW}
			/>,
		)
		// The name column is narrow; what it shows is safe, and cut.
		expectSafe(rows, SPELLED.slice(0, 2))
	})

	it('is spelled out and cut in the closing line', () => {
		const workflow = runRailWorkflow({ ...run, status: 'completed', endedAt: NOW }, [])
		const line = workflowNotice(workflow, NOW).content
		expectSafe([line])
		const long = workflowNotice({ ...workflow, name: 'n'.repeat(200) }, NOW).content
		expect(long).toContain('…')
		expect(long.length).toBeLessThan(100)
	})

	it('is spelled out in the /workflows list', () => {
		const option = workflowRunOption({
			...run,
			status: 'completed',
			endedAt: NOW,
		})
		expectSafe([option.label], SPELLED.slice(0, 2))
		expect(workflowRunOption({ ...run, name: 'n'.repeat(200) }).label).toHaveLength(48)
	})

	it('is spelled out in an agent transcript header', async () => {
		const rows = await draw(
			<AgentTranscript agent={agent} tailOffset={0} terminalRows={30} terminalColumns={110} />,
		)
		expectSafe(rows)
	})

	it('is spelled out in the review before the run starts', () => {
		const q = (text: string) => JSON.stringify(text)
		const script = `export const meta = { name: ${q(HOSTILE)}, description: ${q(`d ${HOSTILE}`)}, phases: [{ title: ${q(`P ${HOSTILE}`)}, detail: ${q(`t ${HOSTILE}`)} }] }\nreturn 1`
		const review = buildPermissionReview([
			{ id: 'w1', name: 'workflow', input: { script }, isDestructive: false },
		])
		if (!review.ok) throw new Error('fixture must fit the approval envelope')
		const summary = buildPermissionSummary(review.text)
		expectSafe(permissionReviewRows(summary.text, 110).map((row) => row.text))
	})
})
