/**
 * A wide cockpit row ends inside its pane.
 *
 * The status and meta half of a wide agent row was `width="50%"`, and at
 * every width tried the row came out one cell wider than its pane: its last
 * character landed on the frame's padding cell, touching the border
 * (`… gpt-5.6-luna · 9.0k│` at 120 columns). It is now a whole number of
 * cells worked out from the pane's own width.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { AgentCockpit } from '../AgentExplorer.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

const child = (viewId: string, description: string): SubagentActivity => ({
	viewId,
	agentId: 'explore',
	description,
	prompt: 'p',
	batchId: 'batch',
	workflowId: 'turn',
	workflowGroupId: 'group',
	phaseId: 'phase-1',
	workflow: 'Two-phase colour sentence',
	phase: 'Phase 1',
	phaseOrder: 0,
	phaseSequence: 1,
	status: 'completed',
	startedAt: 1_000,
	completedAt: 3_700,
	transcript: [],
	model: 'gpt-5.6-luna',
	tokens: 9_000,
})

describe('a wide cockpit agent row', () => {
	it.each([120, 119, 100, 99])('leaves the padding cell before the border blank at %i columns', async (cols) => {
		mounted = await renderToScreen(
			<AgentCockpit
				agents={[child('first', 'Choose first colour'), child('second', 'Choose second colour')]}
				selectedPhaseId="phase-1"
				selectedId="first"
				focus="agents"
				terminalRows={16}
				terminalColumns={cols}
			/>,
			{ cols, rows: 16 },
		)
		const rows = mounted.viewport().filter((row) => row.includes('Choose'))
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			const cells = [...row]
			expect(cells[cols - 1], row).toBe('│')
			expect(cells[cols - 2], row).toBe(' ')
		}
	})
})
