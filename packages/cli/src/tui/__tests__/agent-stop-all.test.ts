import { describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { STOP_ALL_CONFIRM_MS, stopAllStep, stoppableBackgroundAgents } from '../agent-stop-all.js'

function agent(input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>) {
	return {
		agentId: 'general-purpose',
		description: input.viewId,
		prompt: 'p',
		batchId: 'b',
		workflowId: 't',
		workflowGroupId: 'g',
		phaseId: 'p',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'working',
		startedAt: 0,
		transcript: [],
		...input,
	} as SubagentActivity
}

describe('stop-all chord', () => {
	it('waits 3 seconds for the second press', () => {
		expect(STOP_ALL_CONFIRM_MS).toBe(3000)
	})

	it('says so when nothing is running', () => {
		expect(stopAllStep(0, false)).toEqual({
			kind: 'none',
			notice: 'No background agents running',
		})
		expect(stopAllStep(0, true).kind).toBe('none')
	})

	it('arms on the first press and stops on the second, saying how many', () => {
		expect(stopAllStep(2, false)).toEqual({
			kind: 'arm',
			notice: 'Press ctrl+x ctrl+k again to stop 2 background agents',
		})
		expect(stopAllStep(2, true)).toEqual({ kind: 'stop', notice: '2 background agents stopped' })
		expect(stopAllStep(1, true).notice).toBe('1 background agent stopped')
	})

	it('stops only background agents that are still going', () => {
		const rows = [
			agent({ viewId: 'bg', background: true }),
			agent({ viewId: 'fg' }),
			agent({ viewId: 'done', background: true, status: 'completed' }),
			agent({ viewId: 'failed', background: true, status: 'failed' }),
		]
		expect(stoppableBackgroundAgents(rows).map((row) => row.viewId)).toEqual(['bg'])
	})
})
