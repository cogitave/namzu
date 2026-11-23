import { describe, expect, it } from 'vitest'

import { agentListLabel, waitResultLabel } from '../row-labels.js'

describe('the line a status call leaves in the transcript', () => {
	it('says how many agents are running, never the JSON body', () => {
		const body = {
			tasks: [
				{ task_id: 'a', state: 'running' },
				{ task_id: 'b', state: 'completed' },
			],
			total: 2,
			workflows: [{ runId: 'w1', status: 'running' }],
		}
		expect(agentListLabel(JSON.stringify(body))).toBe('1 agent running · 1 workflow running')
		expect(agentListLabel('{"tasks":[],"total":0,"omitted":0}')).toBe('Nothing running')
		expect(agentListLabel(JSON.stringify({ tasks: [{ state: 'failed' }] }))).toBe(
			'1 agent, all finished',
		)
		expect(agentListLabel(JSON.stringify({ agents: [] }))).toBe('No saved agents')
		expect(agentListLabel('not json')).toBe('Checked agents')
	})

	it('says how a wait came out, never the agent answer', () => {
		expect(waitResultLabel('task_id: t\nstatus: completed\n\nAgent result:\nbody')).toBe('Finished')
		expect(waitResultLabel('task_id: t\nstatus: failed\n\nAgent result:\nbody')).toBe('Failed')
		expect(waitResultLabel('Task t is still running; it has not completed.')).toBe('Still running')
		expect(waitResultLabel('w3wivgp4f is a workflow run, not a task, so nothing.')).toBe(
			'Workflow run: nothing to wait for',
		)
	})
})
