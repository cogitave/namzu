import { describe, expect, it } from 'vitest'

import type { PlanManager } from '../../../../manager/plan/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../../provider/index.js'
import { ToolRegistry } from '../../../../registry/index.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../../types/hitl/index.js'
import type { Run, RunEvent } from '../../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../../utils/id.js'
import { query } from '../../index.js'

/**
 * The plan gate is a HITL park, and a Stop has to resolve it.
 *
 * `awaitDecisionOrAbort` races every other park against the run's abort
 * signal — the tool review and the iteration checkpoint both go through
 * `awaitDecisionDurably` — but `runPlanGate` awaited `resumeHandler`
 * directly. A run parked on plan approval therefore ignored a Stop until
 * the host answered, which is the same hang the abort race was introduced
 * to remove elsewhere.
 *
 * Driven through a real `query()` on purpose. A unit test on the phase
 * could be satisfied by wiring the signal into a stub context while the
 * production path still hands the gate a context with no controller.
 */

registerMock()

/** Long enough for the run to settle if it can, short enough to fail fast. */
const SETTLE_WINDOW_MS = 750

function delay(ms: number): Promise<'hung'> {
	return new Promise((resolve) => setTimeout(() => resolve('hung'), ms))
}

interface ParkedPlanRun {
	/** Resolves the moment the host is asked to approve the plan. */
	parked: Promise<void>
	/** Resolves with the run's terminal value, or 'hung' if it never settles. */
	settled: Promise<Run | 'hung'>
	events: RunEvent[]
	requests: HITLDecisionRequest[]
	abort: () => void
}

function startRunParkedOnPlanApproval(): ParkedPlanRun {
	const controller = new AbortController()
	const events: RunEvent[] = []
	const requests: HITLDecisionRequest[] = []

	let markParked: () => void = () => {}
	const parked = new Promise<void>((resolve) => {
		markParked = resolve
	})

	const generator = query({
		provider: new MockLLMProvider({ responses: [{ content: 'done' }] } as never),
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 4 },
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		signal: controller.signal,
		resumeHandler: (request) => {
			requests.push(request)
			markParked()
			// The host that never answers. This is the ordinary shape of a
			// parked run: a human is reading the plan, or an approval queue is
			// holding it for one, and the SDK has no idea which.
			return new Promise<HITLResumeDecision>(() => {})
		},
		onContextCreated: ({ planManager }: { planManager: PlanManager }) => {
			planManager.startGenerating('the work')
			planManager.addStep({ id: 'step_1', description: 'the only step', dependsOn: [], order: 1 })
			planManager.markReady()
		},
	})

	const settled = (async (): Promise<Run | 'hung'> => {
		// A manual drain rather than `for await`, because the run's terminal
		// value is the thing under test and `for await` discards it.
		const iterator = generator[Symbol.asyncIterator]()
		try {
			for (;;) {
				const next = await iterator.next()
				if (next.done) return next.value
				events.push(next.value)
			}
		} finally {
			await iterator.return?.(undefined as never)
		}
	})()

	return {
		parked,
		settled: Promise.race([settled, delay(SETTLE_WINDOW_MS)]),
		events,
		requests,
		abort: () => controller.abort(new Error('operator stopped the run')),
	}
}

describe('a Stop while the run is parked on plan approval', () => {
	it('resolves the park as cancelled instead of waiting for the host', async () => {
		const run = startRunParkedOnPlanApproval()

		await run.parked
		// The park is real: the host was asked for a plan approval and has not
		// answered. Anything else and the abort below would be proving nothing.
		expect(run.requests.map((request) => request.type)).toEqual(['plan_approval'])

		run.abort()

		const outcome = await run.settled
		expect(outcome).not.toBe('hung')
		expect((outcome as Run).status).toBe('cancelled')
		expect((outcome as Run).stopReason).toBe('cancelled')
	})

	it('reports the cancellation on the event stream', async () => {
		const run = startRunParkedOnPlanApproval()

		await run.parked
		run.abort()
		await run.settled

		const completed = run.events.find((event) => event.type === 'run_completed')
		expect(completed).toMatchObject({ stopReason: 'cancelled' })
	})
})
