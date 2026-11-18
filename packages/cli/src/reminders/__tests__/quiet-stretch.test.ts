import {
	type Message,
	createAssistantMessage,
	createRuntimeContextMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { reminderKindOf } from '../frame.js'
import { QUIET_STRETCH_CALLS, QUIET_STRETCH_MS, QuietStretch } from '../quiet-stretch.js'

/**
 * The quiet-stretch nudge. The clock is injected: nothing here waits.
 */

let n = 0
const step = (text?: string): Message[] => {
	n += 1
	return [
		createAssistantMessage(text ?? null, [
			{ id: `c${n}`, type: 'function' as const, function: { name: 'read', arguments: '{}' } },
		]),
		createToolMessage('ok', `c${n}`),
	]
}
const steps = (count: number): Message[] => Array.from({ length: count }, () => step()).flat()

function harness(options: { afterMs?: number; afterCalls?: number } = {}) {
	let clock = 1_000_000
	const stretch = new QuietStretch({ ...options, now: () => clock })
	return {
		stretch,
		advance: (ms: number) => {
			clock += ms
		},
	}
}

describe('the quiet-stretch nudge', () => {
	it('stays silent on the first request after the person writes, however old the clock', () => {
		const { stretch, advance } = harness()
		advance(10 * 60_000)
		expect(stretch.remind([createUserMessage('do the thing')])).toEqual([])
	})

	it('says it once, after enough time and enough calls, and not before either', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('do the thing')]
		stretch.turnStarted()
		stretch.remind(history)
		// Enough calls, not enough time.
		history.push(...steps(QUIET_STRETCH_CALLS))
		advance(QUIET_STRETCH_MS - 1)
		expect(stretch.remind(history)).toEqual([])
		// Enough time, now.
		advance(1)
		const said = stretch.remind(history)
		expect(said).toHaveLength(1)
		expect(reminderKindOf(createRuntimeContextMessage(said[0] as string, 'reminder'))).toBe(
			'quiet-stretch',
		)
		expect(said[0]).toContain('in that same response')
		// Said in the conversation: not again, however long it goes on.
		history.push(createRuntimeContextMessage(said[0] as string, 'reminder'), ...steps(3))
		advance(30 * 60_000)
		expect(stretch.remind(history)).toEqual([])
	})

	it('needs the calls as well as the time: one long command is not a quiet stretch of work', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('build it'), ...steps(QUIET_STRETCH_CALLS - 1)]
		stretch.turnStarted()
		stretch.remind(history)
		advance(20 * 60_000)
		expect(stretch.remind(history)).toEqual([])
	})

	it('does not count time spent waiting on the person', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('go'), ...steps(QUIET_STRETCH_CALLS)]
		stretch.turnStarted()
		stretch.remind(history)
		advance(30_000)
		const answered = stretch.waitStarted()
		advance(10 * 60_000)
		answered()
		advance(30_000)
		// 60 s of work in 10 min 60 s.
		expect(stretch.remind(history)).toEqual([])
		advance(30_000)
		expect(stretch.remind(history)).toHaveLength(1)
	})

	it('does not count a wait that is still open', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('go'), ...steps(QUIET_STRETCH_CALLS)]
		stretch.turnStarted()
		stretch.remind(history)
		stretch.waitStarted()
		advance(10 * 60_000)
		expect(stretch.remind(history)).toEqual([])
	})

	it('starts over when the assistant says something the person can see', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('go'), ...steps(QUIET_STRETCH_CALLS)]
		stretch.turnStarted()
		stretch.remind(history)
		advance(QUIET_STRETCH_MS)
		expect(stretch.remind(history)).toHaveLength(1)
		// The model answers with a sentence and its next call: a new stretch.
		history.push(...step('Reading the config, found two copies.'), ...steps(QUIET_STRETCH_CALLS))
		advance(10_000)
		expect(stretch.remind(history)).toEqual([])
		advance(QUIET_STRETCH_MS)
		expect(stretch.remind(history)).toHaveLength(1)
	})

	it('starts over at the person next message and ignores the time between turns', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('go'), ...steps(QUIET_STRETCH_CALLS)]
		stretch.turnStarted()
		stretch.remind(history)
		advance(QUIET_STRETCH_MS)
		expect(stretch.remind(history)).toHaveLength(1)
		history.push(createAssistantMessage('Done.'), createUserMessage('and now this'))
		advance(3 * 60 * 60_000)
		stretch.turnStarted()
		expect(stretch.remind(history)).toEqual([])
		history.push(...steps(QUIET_STRETCH_CALLS))
		advance(QUIET_STRETCH_MS - 1)
		expect(stretch.remind(history)).toEqual([])
	})

	it('reads another note from the host as neither text nor the person', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [
			createUserMessage('go'),
			createRuntimeContextMessage(
				'<system-reminder kind="environment">x</system-reminder>',
				'reminder',
			),
			...steps(QUIET_STRETCH_CALLS),
		]
		stretch.turnStarted()
		stretch.remind(history)
		advance(QUIET_STRETCH_MS)
		expect(stretch.remind(history)).toHaveLength(1)
	})

	it('takes its thresholds from options', () => {
		const { stretch, advance } = harness({ afterMs: 5_000, afterCalls: 2 })
		const history: Message[] = [createUserMessage('go'), ...steps(2)]
		stretch.turnStarted()
		stretch.remind(history)
		advance(5_000)
		expect(stretch.remind(history)).toHaveLength(1)
	})

	it('counts a review or a question as a wait through the session events', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('go'), ...steps(QUIET_STRETCH_CALLS)]
		stretch.turnStarted()
		stretch.remind(history)
		stretch.observe({ type: 'tool_review_requested' })
		advance(10 * 60_000)
		stretch.observe({ type: 'tool_review_completed' })
		stretch.observe({ type: 'user_question_asked', questionId: 'q1' })
		advance(10 * 60_000)
		stretch.observe({ type: 'user_question_answered', questionId: 'q1' })
		advance(QUIET_STRETCH_MS - 1)
		expect(stretch.remind(history)).toEqual([])
		advance(1)
		expect(stretch.remind(history)).toHaveLength(1)
	})

	it('lets go of a wait when the turn stops under it', () => {
		const { stretch, advance } = harness()
		const history: Message[] = [createUserMessage('go'), ...steps(QUIET_STRETCH_CALLS)]
		stretch.turnStarted()
		stretch.remind(history)
		stretch.observe({ type: 'tool_review_requested' })
		stretch.observe({ type: 'turn_failed' })
		advance(QUIET_STRETCH_MS)
		expect(stretch.remind(history)).toHaveLength(1)
	})
})
