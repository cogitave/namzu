import { describe, expect, it } from 'vitest'

import { SubagentActivityMonitor } from '../activity.js'

function running() {
	const monitor = new SubagentActivityMonitor()
	const tracker = monitor.begin({
		agentId: 'general-purpose',
		description: 'Count words',
		prompt: 'p',
	})
	tracker.onEvent({
		type: 'agent_pending',
		taskId: 'task-1',
		childAgentId: 'general-purpose',
	} as never)
	tracker.onEvent({ type: 'turn_started', sessionId: 's1' } as never)
	return { monitor, tracker }
}

const snapshot = (monitor: SubagentActivityMonitor) => monitor.getSnapshot()[0]

describe('messages waiting for a running agent', () => {
	it('counts each message until the agent finishes a tool round', () => {
		const { monitor, tracker } = running()
		expect(snapshot(monitor)?.queued).toBeUndefined()
		monitor.recordMessage('task-1', 'one', 'operator-to-child')
		monitor.recordMessage('task-1', 'two', 'to-child')
		expect(snapshot(monitor)?.queued).toBe(2)
		tracker.onEvent({
			type: 'tool_executing',
			toolName: 'Read',
			toolUseId: 't',
			input: { path: 'a.txt' },
		} as never)
		expect(snapshot(monitor)?.queued).toBe(2)
		tracker.onEvent({
			type: 'tool_completed',
			toolName: 'Read',
			toolUseId: 't',
			isError: false,
			result: 'ok',
		} as never)
		expect(snapshot(monitor)?.queued).toBeUndefined()
		monitor.close()
	})

	it('shows the typed words as the person’s own row', () => {
		const { monitor, tracker } = running()
		tracker.onEvent({
			type: 'tool_executing',
			toolName: 'Read',
			toolUseId: 't',
			input: { path: 'a.txt' },
		} as never)
		monitor.recordMessage('task-1', 'please also count lines', 'operator-to-child')
		const shown = snapshot(monitor)
		expect(
			shown?.transcript.some(
				(row) =>
					row.kind === 'system' &&
					row.direction === 'operator-to-child' &&
					row.text === 'please also count lines',
			),
		).toBe(true)
		monitor.close()
	})

	it('counts nothing for a message that resumes a finished agent', () => {
		const { monitor } = running()
		monitor.recordMessage('task-1', 'resume', 'operator-to-child', 'started')
		expect(snapshot(monitor)?.queued).toBeUndefined()
		monitor.close()
	})
})
