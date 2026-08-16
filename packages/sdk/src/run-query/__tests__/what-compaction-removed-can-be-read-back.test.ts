import { describe, expect, it } from 'vitest'

import type { RunId } from '../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import type { PersistedRunEvent, RunStore } from '../../types/run/index.js'
import { RunQuery } from '../index.js'

/**
 * Asking a finished run what happened.
 *
 * The stores could each answer part of it and nothing could answer the
 * question. `readEvents` gives a log; `writeMessages` persisted a history;
 * and the two disagree BY DESIGN once compaction has run — the persisted
 * history is what survived, and what compaction removed lives only in the
 * log. `compaction_shed` has carried "exactly the messages the pass
 * removed" since NZ-RUNREC-06, shadowed there precisely so it would not be
 * lost, and nothing read it back. Evidence nobody can retrieve is evidence
 * nobody kept.
 */

const RUN = 'run_q' as RunId

let seq = 0
const event = (type: string, over: Record<string, unknown> = {}): PersistedRunEvent =>
	({ type, runId: RUN, seq: ++seq, timestamp: 1_000 + seq, ...over }) as PersistedRunEvent

const reset = () => {
	seq = 0
}

function storeWith(events: PersistedRunEvent[]): RunStore {
	return {
		async readEvents() {
			return events
		},
	} as unknown as RunStore
}

const shed = (messages: Message[], over: Record<string, unknown> = {}) =>
	event('compaction_shed', { iteration: 1, reason: 'threshold', messages, ...over })

describe('what compaction removed can be read back', () => {
	it('returns every shed pass, oldest first', async () => {
		reset()
		const first = [createUserMessage('the first thing')]
		const second = [createUserMessage('the second thing')]
		const query = new RunQuery({
			store: storeWith([
				event('run_started'),
				shed(first, { iteration: 3 }),
				event('iteration_started', { iteration: 4 }),
				shed(second, { iteration: 7, reason: 'overflow' }),
			]),
		})

		const passes = await query.shedHistory()

		expect(passes.map((p) => p.iteration)).toEqual([3, 7])
		expect(passes.map((p) => p.reason)).toEqual(['threshold', 'overflow'])
		expect(passes[0]?.messages).toEqual(first)
	})

	it('carries the log position, for a caller correlating with events', async () => {
		reset()
		const query = new RunQuery({
			store: storeWith([event('run_started'), shed([createUserMessage('gone')])]),
		})

		expect((await query.shedHistory())[0]?.seq).toBe(2)
	})

	it('says nothing for a run that never compacted', async () => {
		reset()
		const query = new RunQuery({ store: storeWith([event('run_started')]) })

		expect(await query.shedHistory()).toEqual([])
	})
})

describe('the full transcript is complete', () => {
	it('carries a message compaction removed AND the ones that survived', async () => {
		// The question somebody reconstructing an incident is actually asking.
		reset()
		const gone = createUserMessage('the instruction that was shed')
		const survived = [createAssistantMessage('a summary'), createUserMessage('and then')]
		const query = new RunQuery({
			store: storeWith([event('run_started'), shed([gone])]),
		})

		const full = await query.fullTranscript(survived)

		expect(full).toHaveLength(3)
		expect(full[0]).toBe(gone)
		expect(full.slice(1)).toEqual(survived)
	})

	it('returns the SAME array when nothing was shed', async () => {
		// So the common case costs one log read and no allocation.
		reset()
		const messages = [createUserMessage('hello')]
		const query = new RunQuery({ store: storeWith([event('run_started')]) })

		expect(await query.fullTranscript(messages)).toBe(messages)
	})

	it('keeps two passes in the order they happened', async () => {
		reset()
		const a = createUserMessage('A')
		const b = createUserMessage('B')
		const query = new RunQuery({
			store: storeWith([event('run_started'), shed([a]), shed([b])]),
		})

		const full = await query.fullTranscript([createUserMessage('C')])

		expect(full.map((m) => m.content)).toEqual(['A', 'B', 'C'])
	})
})

describe('status comes from the read model, not a second fold', () => {
	it('answers about a finished run', async () => {
		// Two folds of one log are two chances to disagree, and a run that
		// reads differently depending on which surface asked is what this
		// seam exists to remove.
		reset()
		const query = new RunQuery({
			store: storeWith([event('run_started'), event('run_completed')]),
		})

		expect(await query.status()).toBe('succeeded')
	})

	it('answers about a run waiting on a human', async () => {
		reset()
		const query = new RunQuery({
			store: storeWith([event('run_started'), event('tool_review_requested', { toolCalls: [] })]),
		})

		expect(await query.status()).toBe('awaiting_hitl')
	})

	it('hands back the whole projected state for a caller that wants the park', async () => {
		reset()
		const query = new RunQuery({
			store: storeWith([event('run_started'), event('tool_review_requested', { toolCalls: [] })]),
		})

		const state = await query.statusState()

		expect(state.execution).toBe('running')
		expect(state.park).toBeDefined()
	})

	it('says queued for a run whose log is empty', async () => {
		reset()
		expect(await new RunQuery({ store: storeWith([]) }).status()).toBe('queued')
	})
})

describe('the events themselves', () => {
	it('are handed back oldest first, as the store gave them', async () => {
		// Not re-sorted. A log that needs sorting was written by two
		// processes, and hiding that produces a plausible transcript of a run
		// that never happened.
		reset()
		const events = [event('run_started'), event('iteration_started', { iteration: 1 })]
		const query = new RunQuery({ store: storeWith(events) })

		expect(await query.events()).toBe(events)
	})
})
