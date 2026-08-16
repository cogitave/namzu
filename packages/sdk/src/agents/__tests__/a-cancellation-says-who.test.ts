import { describe, expect, it } from 'vitest'

import { RunCancelled, cancelCauseOf } from '../../types/run/cancel-cause.js'
import { abortReasonText } from '../../utils/abort.js'

/**
 * `stopReason: 'cancelled'` said a run was cancelled and nothing more, and
 * the cases behind it want different responses. An operator pressing
 * cancel is not a defect. A parent abandoning its children is a fact about
 * the parent, and looking for the child's problem wastes the reader's
 * time.
 *
 * The information was not discarded — it was never carried.
 * `AbstractAgent.cancel()` aborted with no argument at all, and the agent
 * manager aborted a child with the bare string `'canceled'`, which
 * `abortReasonText` suppresses BY NAME: its docblock cites that exact call
 * site, because rendering it would print "was cancelled: canceled". Both
 * paths arrived at the run loop indistinguishable.
 */

describe('an abort reason that carries a cause', () => {
	it('is legible to the cause reader and silent to the prose renderer', () => {
		// One signal, both assertions, because the pair is the design. The
		// cause must NOT become prose in the run's error text — that is the
		// noise `abortReasonText` exists to suppress — and it must still be
		// recoverable by something asking for it directly.
		const controller = new AbortController()
		controller.abort(new RunCancelled('parent'))

		expect(abortReasonText(controller.signal.reason)).toBeUndefined()
		expect(cancelCauseOf(controller.signal.reason)).toBe('parent')
	})

	it('reports undefined for an abort nobody attributed', () => {
		// The honest answer. Substituting `'user'` would name a person who
		// pressed nothing, and it would do so in exactly the case where the
		// reader most needs to know the origin was not recorded.
		const controller = new AbortController()
		controller.abort()

		expect(cancelCauseOf(controller.signal.reason)).toBeUndefined()
	})

	it('reports undefined for the old bare-string reason', () => {
		// The value the agent manager used to abort with. It must not be
		// mistaken for a cause now that one exists.
		expect(cancelCauseOf('canceled')).toBeUndefined()
	})

	it('is recognised by name, not by instanceof', () => {
		// Two copies of the package defeat `instanceof` and nothing announces
		// it — the answer this codebase already settled on for provider
		// errors. A structural twin from another copy must still be read.
		const fromAnotherCopy = Object.assign(new Error('run cancelled by budget'), {
			name: 'RunCancelled',
			cancelCause: 'budget' as const,
		})

		expect(cancelCauseOf(fromAnotherCopy)).toBe('budget')
	})

	it('does not collide with Error.cause', () => {
		// `Error.cause` already exists and means "the error this one
		// wrapped". Reusing that name would put two unrelated meanings on one
		// property and change what anything reading `err.cause` gets.
		const cancelled = new RunCancelled('hook')

		expect(cancelled.cancelCause).toBe('hook')
		expect(cancelled.cause).toBeUndefined()
	})
})
