import { describe, expect, it } from 'vitest'

import { abortReasonText } from '../abort.js'

/**
 * A cancellation and a deadline arrive by the same mechanism and mean opposite
 * things to whoever reads the result. The distinction only survives if the
 * words a caller attached travel with the abort — and only if the words the
 * platform invents on a caller's behalf do NOT, because a fabricated
 * explanation is worse than an honest silence.
 */

describe('a stop carries the words its caller gave it', () => {
	it('reports a reason someone wrote', () => {
		expect(abortReasonText(new Error('deployment window closed'))).toBe('deployment window closed')
	})

	it('reports a named deadline, which is the case this exists for', () => {
		const reason = new Error('run budget of 30000ms exhausted')
		expect(abortReasonText(reason)).toBe('run budget of 30000ms exhausted')
	})
})

describe('a stop with nothing to say stays silent', () => {
	it('says nothing for a bare abort()', () => {
		// `abort()` with no argument fills `reason` with a DOMException named
		// AbortError. Nobody wrote that word; it is the platform's way of
		// saying the caller gave no reason, and rendering it would turn "we
		// do not know" into what looks like an answer.
		const controller = new AbortController()
		controller.abort()

		expect(controller.signal.reason).toBeInstanceOf(Error)
		expect((controller.signal.reason as Error).name).toBe('AbortError')
		expect(abortReasonText(controller.signal.reason)).toBeUndefined()
	})

	it('says nothing for a platform timeout', () => {
		const timeout = new Error('The operation was aborted due to timeout')
		timeout.name = 'TimeoutError'
		expect(abortReasonText(timeout)).toBeUndefined()
	})

	it('says nothing for a non-Error reason', () => {
		// The agent manager aborts a child with the bare string 'canceled'.
		// Rendering it produces "was cancelled: canceled" — noise wearing the
		// shape of information.
		expect(abortReasonText('canceled')).toBeUndefined()
		expect(abortReasonText(undefined)).toBeUndefined()
		expect(abortReasonText({ message: 'not an Error' })).toBeUndefined()
	})

	it('says nothing for an Error whose message is empty', () => {
		expect(abortReasonText(new Error('   '))).toBeUndefined()
	})
})
