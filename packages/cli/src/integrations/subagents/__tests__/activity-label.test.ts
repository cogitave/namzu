import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	type AskForLabel,
	LABEL_INTERVAL_MS,
	LABEL_MAX_CHARS,
	startActivityLabeler,
	validateLabel,
} from '../activity-label.js'
import { SubagentActivityMonitor } from '../activity.js'

describe('validating a label', () => {
	it('keeps one plain line and drops everything else', () => {
		expect(validateLabel('  Reading config loader  ')).toBe('Reading config loader')
		expect(validateLabel('')).toBeUndefined()
		expect(validateLabel('two\nlines')).toBeUndefined()
		expect(validateLabel('# Heading')).toBeUndefined()
		expect(validateLabel('```ts')).toBeUndefined()
		expect(validateLabel('x'.repeat(LABEL_MAX_CHARS))).toBeDefined()
		expect(validateLabel('x'.repeat(LABEL_MAX_CHARS + 1))).toBeUndefined()
	})
})

describe('the live label of a background agent', () => {
	let monitor: SubagentActivityMonitor
	beforeEach(() => {
		vi.useFakeTimers()
		monitor = new SubagentActivityMonitor()
	})
	afterEach(() => {
		monitor.close()
		vi.useRealTimers()
	})

	function launch(background = true) {
		const tracker = monitor.begin({
			agentId: 'general-purpose',
			description: 'Count words',
			prompt: 'count words in a.txt',
			background,
		})
		tracker.onEvent({
			type: 'agent_pending',
			taskId: 't',
			childAgentId: 'general-purpose',
		} as never)
		tracker.onEvent({ type: 'turn_started', sessionId: 's' } as never)
		return tracker
	}
	const tool = (tracker: ReturnType<typeof launch>, id: string) => {
		tracker.onEvent({
			type: 'tool_executing',
			toolName: 'Read',
			toolUseId: id,
			input: { path: id },
		} as never)
		tracker.onEvent({
			type: 'tool_completed',
			toolName: 'Read',
			toolUseId: id,
			isError: false,
			result: 'ok',
		} as never)
	}
	const shown = () => monitor.getSnapshot()[0]

	it('waits for three messages, then labels once per interval and only when the transcript moved', async () => {
		const ask = vi.fn<AskForLabel>(async () => ({ text: 'Reading a.txt' }))
		const labeler = startActivityLabeler({ activity: monitor, ask })
		const tracker = launch()
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		expect(ask).not.toHaveBeenCalled() // one message: nothing to describe yet
		tool(tracker, 'a')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		expect(ask).not.toHaveBeenCalled() // two: still too little
		tool(tracker, 'a2')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		expect(ask).toHaveBeenCalledTimes(1)
		expect(ask.mock.calls[0]?.[2]).toContain('count words in a.txt')
		expect(shown()?.summary).toBe('Reading a.txt')
		// Nothing new happened: no second request.
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS * 3)
		expect(ask).toHaveBeenCalledTimes(1)
		// New work: asked again, with the previous label in front of the model.
		ask.mockResolvedValueOnce({ text: 'Checking b.txt' })
		tool(tracker, 'b')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		expect(ask).toHaveBeenCalledTimes(2)
		expect(ask.mock.calls[1]?.[2]).toContain('Previous label: Reading a.txt')
		expect(shown()?.summary).toBe('Checking b.txt')
		labeler.stop()
	})

	it('drops an unusable reply and keeps the old label', async () => {
		const ask = vi.fn<AskForLabel>(async () => ({ text: 'Reading a.txt' }))
		const labeler = startActivityLabeler({ activity: monitor, ask })
		const tracker = launch()
		tool(tracker, 'a')
		tool(tracker, 'a2')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		ask.mockResolvedValueOnce({ text: '## not a label\nsecond line' })
		tool(tracker, 'b')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		expect(shown()?.summary).toBe('Reading a.txt')
		ask.mockRejectedValueOnce(new Error('offline'))
		tool(tracker, 'c')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		expect(shown()?.summary).toBe('Reading a.txt')
		labeler.stop()
	})

	it('never labels a foreground agent, and stops when the agent ends', async () => {
		const ask = vi.fn<AskForLabel>(async () => ({ text: 'Reading a.txt' }))
		const labeler = startActivityLabeler({ activity: monitor, ask })
		const foreground = launch(false)
		tool(foreground, 'a')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS * 2)
		expect(ask).not.toHaveBeenCalled()
		labeler.stop()
	})

	it('shows no label once the agent has ended', async () => {
		const ask = vi.fn<AskForLabel>(async () => ({ text: 'Reading a.txt' }))
		const labeler = startActivityLabeler({ activity: monitor, ask })
		const tracker = launch()
		tool(tracker, 'a')
		tool(tracker, 'a2')
		await vi.advanceTimersByTimeAsync(LABEL_INTERVAL_MS)
		expect(shown()?.summary).toBe('Reading a.txt')
		tracker.onEvent({ type: 'agent_completed', result: { status: 'completed' } } as never)
		expect(shown()?.summary).toBeUndefined()
		monitor.setSummary(shown()?.viewId ?? '', 'late')
		expect(shown()?.summary).toBeUndefined()
		labeler.stop()
	})
})
