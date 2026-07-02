import { describe, expect, it } from 'vitest'

import type { HITLResumeDecision } from '../../../../types/hitl/index.js'
import type { RunId } from '../../../../types/ids/index.js'
import { type IterationContext, awaitDecisionOrAbort } from './context.js'

/**
 * C12: a Stop that arrives while the run is parked on a HITL decision must
 * interrupt the park (resolve as `abort`) instead of hanging until the host
 * eventually answers. `awaitDecisionOrAbort` races `resumeHandler` against
 * `ctx.abortController.signal`.
 */

function ctxWith(opts: {
	controller?: AbortController
	resumeHandler: IterationContext['resumeHandler']
}): IterationContext {
	return {
		abortController: opts.controller,
		resumeHandler: opts.resumeHandler,
		runMgr: { id: 'run_abort_test' as RunId },
	} as unknown as IterationContext
}

const REVIEW_REQUEST = {
	type: 'tool_review' as const,
	runId: 'run_abort_test' as RunId,
	checkpointId: 'cp_1' as `cp_${string}`,
	toolCalls: [],
}

describe('awaitDecisionOrAbort (C12 — cancellable HITL park)', () => {
	it('returns abort immediately when the signal is already aborted', async () => {
		const controller = new AbortController()
		controller.abort()
		const ctx = ctxWith({
			controller,
			// A handler that never resolves — proving we did not wait on it.
			resumeHandler: () => new Promise<HITLResumeDecision>(() => {}),
		})
		const decision = await awaitDecisionOrAbort(ctx, REVIEW_REQUEST)
		expect(decision.action).toBe('abort')
	})

	it('resolves as abort when the signal fires DURING the park', async () => {
		const controller = new AbortController()
		const ctx = ctxWith({
			controller,
			resumeHandler: () => new Promise<HITLResumeDecision>(() => {}), // never answers
		})
		const pending = awaitDecisionOrAbort(ctx, REVIEW_REQUEST)
		controller.abort()
		const decision = await pending
		expect(decision.action).toBe('abort')
	})

	it('returns the real decision when the handler answers before any abort', async () => {
		const controller = new AbortController()
		const ctx = ctxWith({
			controller,
			resumeHandler: async () => ({ action: 'approve_tools' }) as HITLResumeDecision,
		})
		const decision = await awaitDecisionOrAbort(ctx, REVIEW_REQUEST)
		expect(decision.action).toBe('approve_tools')
	})

	it('degrades to a direct resumeHandler await when no controller is wired', async () => {
		const ctx = ctxWith({
			resumeHandler: async () => ({ action: 'reject_tools' }) as HITLResumeDecision,
		})
		const decision = await awaitDecisionOrAbort(ctx, REVIEW_REQUEST)
		expect(decision.action).toBe('reject_tools')
	})

	it('fails closed to abort when the resume handler rejects', async () => {
		const controller = new AbortController()
		const ctx = ctxWith({
			controller,
			resumeHandler: async () => {
				throw new Error('handler boom')
			},
		})
		const decision = await awaitDecisionOrAbort(ctx, REVIEW_REQUEST)
		expect(decision.action).toBe('abort')
	})
})
