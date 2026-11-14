/**
 * A launch row for background agents or a workflow has one dim line under it
 * saying where to follow the work: the `↓` key and `/tasks`. A batch the turn
 * waits on has no such line.
 */

import { describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { WORKFLOW_BACKGROUND_NOTE } from '../../integrations/workflows/offering.js'
import { settledBatchRows } from '../restored-rows.js'

function agent(
	input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>,
): SubagentActivity {
	return {
		agentId: 'general-purpose',
		description: input.viewId,
		prompt: 'p',
		batchId: 'batch-1',
		workflowId: 'turn-1',
		workflowGroupId: 'group-1',
		phaseId: 'phase-1',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'completed',
		startedAt: 1_000,
		transcript: [],
		...input,
	}
}

describe('the line under a background launch', () => {
	it('names the key and the command, in a dim result row', () => {
		expect(WORKFLOW_BACKGROUND_NOTE).toBe('Running in the background · follow it with ↓ or /tasks')
		const rows = settledBatchRows([agent({ viewId: 'solo', background: true })])
		expect(rows.map((r) => [r.glyph, r.content])).toEqual([
			['●', 'Launched solo'],
			['⎿', WORKFLOW_BACKGROUND_NOTE],
		])
	})

	it('is absent for agents the turn waited on', () => {
		const rows = settledBatchRows([agent({ viewId: 'solo' })])
		expect(rows.map((r) => r.glyph)).toEqual(['●'])
	})
})
