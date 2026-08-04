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
