// Current-code invariants asserted (2026-07-12, ses_015 pre-freeze M1):
// - A run whose signal is ALREADY aborted when the loop starts does no work at
//   all: the plan gate never runs, so no checkpoint is written and no HITL
//   decision is awaited. The run ends 'cancelled' and the provider is never
//   called.
//   This matters because the plan gate runs BEFORE the loop's own guard check.
//   `query()` pre-aborts its controller when the caller's signal is already
//   aborted (context.ts), so without the short-circuit a cancelled run still
//   created a checkpoint and could block indefinitely on a human approving a plan
//   it can never act on.
// - Positive control: with a live signal, the same armed plan gate DOES run —
//   the checkpoint is created and the decision handler is consulted — so the
//   assertion above is testing the abort, not a dead gate.
import { describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../../../../types/run/index.js'
import { IterationOrchestrator } from '../index.js'

interface Harness {
	orchestrator: IterationOrchestrator
	createCheckpoint: ReturnType<typeof vi.fn>
	resumeHandler: ReturnType<typeof vi.fn>
	setStopReason: ReturnType<typeof vi.fn>
	markCancelled: ReturnType<typeof vi.fn>
	chat: ReturnType<typeof vi.fn>
}

/** An orchestrator whose plan gate is armed: an active plan in 'ready' status. */
function makeHarness(signal: AbortSignal, abortController: AbortController): Harness {
	const createCheckpoint = vi.fn(async () => ({ id: 'cp_test' }))
	const resumeHandler = vi.fn(async () => ({ action: 'abort' as const, reason: 'test' }))
	const setStopReason = vi.fn()
	const markCancelled = vi.fn()
	const chat = vi.fn()

	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

	const runMgr = {
		id: 'run_test',
		messages: [],
		currentIteration: 0,
		setStopReason,
		markCancelled,
	}

	const planManager = {
		active: {
			id: 'plan_test',
			status: 'ready',
			title: 'a plan',
			steps: [],
			summary: 'summary',
		},
	}

	const orchestrator = new IterationOrchestrator(
		{ provider: { id: 'fake', chat }, runConfig: { model: 'm' }, tools: {} } as any,
		runMgr as any,
		{} as any,
		{ beforeIteration: () => ({ shouldStop: true, stopReason: 'end_turn' }) } as any,
		{ create: () => null } as any,
		vi.fn(async () => {}),
		function* (): Generator<RunEvent> {},
		abortController,
		log as any,
		resumeHandler as any,
		{ create: createCheckpoint } as any,
		planManager as any,
	)

	void signal
	return { orchestrator, createCheckpoint, resumeHandler, setStopReason, markCancelled, chat }
}

async function drain(orchestrator: IterationOrchestrator): Promise<void> {
	for await (const _event of orchestrator.runLoop()) {
		// events are irrelevant here
	}
}

describe('iteration loop — a pre-aborted run short-circuits', () => {
	it('skips the plan gate entirely: no checkpoint, no HITL wait, no model call', async () => {
		const controller = new AbortController()
		controller.abort()
		const h = makeHarness(controller.signal, controller)

		await drain(h.orchestrator)

		expect(h.createCheckpoint).not.toHaveBeenCalled()
		expect(h.resumeHandler).not.toHaveBeenCalled()
		expect(h.chat).not.toHaveBeenCalled()
		expect(h.setStopReason).toHaveBeenCalledWith('cancelled')
		expect(h.markCancelled).toHaveBeenCalledTimes(1)
	})

	it('positive control: a live signal still runs the armed plan gate', async () => {
		const controller = new AbortController()
		const h = makeHarness(controller.signal, controller)

		await drain(h.orchestrator)

		expect(h.createCheckpoint).toHaveBeenCalledTimes(1)
		expect(h.resumeHandler).toHaveBeenCalledTimes(1)
	})
})
