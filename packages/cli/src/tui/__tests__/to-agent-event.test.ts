import { describe, expect, it } from 'vitest'

import type { RunEvent, RunId } from '@namzu/sdk'

import { toAgentEvent } from '../agent.js'

/**
 * The seam between the kernel and the command.
 *
 * The SDK test proves `run_completed` carries a stop reason and the `run` test
 * proves the command acts on one, and both of those passed while this function
 * threw the field away in between — the mutation that reverted it to a bare
 * `{ kind: 'done' }` was caught by nothing. Two tested ends and an untested
 * middle is the shape that lets a value be produced and consumed and still
 * never arrive.
 */

const runId = 'run_test' as RunId

describe('toAgentEvent carries the stop reason across', () => {
	it('passes a non-normal stop through to the done event', () => {
		const mapped = toAgentEvent({
			type: 'run_completed',
			runId,
			result: '',
			stopReason: 'output_guardrail',
		} as RunEvent)

		expect(mapped).toEqual({ kind: 'done', stopReason: 'output_guardrail' })
	})

	it('passes end_turn through rather than inventing it downstream', () => {
		// The command treats a MISSING reason as success, so the difference
		// between "finished normally" and "we did not say" must be preserved
		// here rather than reconstructed by whoever reads it.
		const mapped = toAgentEvent({
			type: 'run_completed',
			runId,
			result: 'hi',
			stopReason: 'end_turn',
		} as RunEvent)

		expect(mapped).toEqual({ kind: 'done', stopReason: 'end_turn' })
	})

	it('still maps a completion that carries no reason', () => {
		const mapped = toAgentEvent({ type: 'run_completed', runId, result: 'hi' } as RunEvent)

		expect(mapped).toEqual({ kind: 'done' })
	})

	it('maps a failure to an error, not to done', () => {
		const mapped = toAgentEvent({
			type: 'run_failed',
			runId,
			error: 'boom',
		} as RunEvent)

		expect(mapped).toEqual({ kind: 'error', message: 'boom' })
	})
})

describe('compaction is reported, not silent', () => {
	// Compaction deletes messages irrecoverably. The kernel emits both outcomes
	// specifically so a host can surface the loss; this host used to drop them
	// at `default: return null`, one function from the screen.
	it('says which counts became which, and nothing it cannot substantiate', () => {
		const mapped = toAgentEvent({
			type: 'compaction_completed',
			runId: 'run_1',
			iteration: 3,
			messagesBefore: 42,
			messagesAfter: 9,
			tokensBefore: 120_000,
			tokensAfter: 38_000,
			measuredBy: 'provider',
			contextWindowTokens: 200_000,
			windowSource: 'model-table',
			reachedResetThreshold: true,
		} as never)

		expect(mapped).toMatchObject({ kind: 'context', shed: true })
		const text = (mapped as { text: string }).text
		expect(text).toContain('42')
		expect(text).toContain('9')
		expect(text).toContain('120k')
		// It must NOT claim to know what was lost — only the counts are checkable.
		expect(text).not.toMatch(/turns? \d+-\d+|removed the/i)
	})

	it('marks an estimate as an estimate', () => {
		// Quoting an estimate as a measurement is the same lie as quoting a
		// summary as an enumeration, in miniature.
		const mapped = toAgentEvent({
			type: 'compaction_completed',
			runId: 'run_1',
			iteration: 3,
			messagesBefore: 10,
			messagesAfter: 4,
			tokensBefore: 9000,
			tokensAfter: 3000,
			measuredBy: 'estimate',
			contextWindowTokens: 200_000,
			windowSource: 'default',
			reachedResetThreshold: false,
		} as never)

		expect((mapped as { text: string }).text).toContain('estimated')
	})
})

describe('the three decline causes get three sentences', () => {
	// Collapsing them into "compaction failed" puts the reader back where the
	// silence did — the same reason a rule denial had to quote the rule.
	function failure(cause: string, error?: string): string {
		const mapped = toAgentEvent({
			type: 'compaction_failed',
			runId: 'run_1',
			iteration: 2,
			cause,
			messages: 31,
			...(error ? { error } : {}),
		} as never)
		expect(mapped).toMatchObject({ kind: 'context', shed: false })
		return (mapped as { text: string }).text
	}

	it('a thrown reducer may work next time, and carries its own error', () => {
		const text = failure('reducer_threw', 'provider returned 400')

		expect(text).toContain('provider returned 400')
		expect(text).toContain('a later pass may succeed')
	})

	it('shedding nothing is a fact, not an error, and will not change', () => {
		const text = failure('shed_nothing')

		expect(text).toContain('later passes will answer the same')
		// Not dressed as a failure: an irreducible history is a true statement
		// about the conversation, and calling it one sends someone hunting a
		// bug that is not there.
		expect(text).not.toMatch(/failed|error/i)
	})

	it('a split tool pair is a reducer bug and suggests no user action', () => {
		const text = failure('split_tool_pair')

		expect(text).toContain('bug in the reducer')
		expect(text).not.toMatch(/try again|later pass|retry/i)
	})

	it('every cause states the history is unchanged', () => {
		for (const cause of ['reducer_threw', 'shed_nothing', 'split_tool_pair']) {
			expect(failure(cause)).toContain('31 messages unchanged')
		}
	})

	it('no two causes produce the same sentence', () => {
		const texts = ['reducer_threw', 'shed_nothing', 'split_tool_pair'].map((c) => failure(c))

		expect(new Set(texts).size).toBe(3)
	})
})
