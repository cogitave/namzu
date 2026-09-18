import { type MockInstance, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import { isTerminalStatus } from '../../../types/common/index.js'
import { deriveRunStatus } from '../../../types/run/derive-status.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { query } from '../index.js'

/**
 * A consumer that walks away leaves a run that is over, and the durable
 * record has to say so.
 *
 * `persist()` is reached from exactly one place — `ResultAssembler.finalize()`
 * — and that call sits after the `try/catch/finally` rather than inside it.
 * `for await (… ) break` and `gen.return()` both run the `finally` (jobs
 * killed, sandbox destroyed, span ended, duration recorded) and both skip
 * everything after it. The run is torn down and the store keeps whatever
 * `init()` wrote, which is not a terminal state, so a host rebuilding its
 * view from the store sees work that is not happening.
 *
 * `drainQuery` drains to completion and never abandons, so this is the
 * `for await` surface only.
 */

registerMock()

const RUN_CONFIG = { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 4 }

interface RunUnderTest {
	generator: AsyncGenerator<RunEvent, Run>
	runStore: InMemoryRunStore
	/** Every durable run-meta write this run performed, wherever it came from. */
	writes: MockInstance
	/** The teardown the run's `finally` block performs. */
	killOwner: MockInstance
}

function startRun(): RunUnderTest {
	const runStore = new InMemoryRunStore()
	const jobs = new BackgroundJobRegistry()

	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'echo',
			description: 'echoes its input',
			inputSchema: z.object({ text: z.string() }),
			category: 'shell',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async ({ text }) => ({ success: true, output: text }),
		}),
	)

	const generator = query({
		// One tool turn then an answer. The first turn is what carries the run
		// past the model call and into the checkpoint phase, which is where a
		// host that walks away leaves a durable run behind.
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'ready' } }] }, { text: 'done' }],
		} as never),
		tools,
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: process.cwd(),
		runStore,
		checkpointStore: new InMemoryCheckpointStore(),
		backgroundJobs: jobs,
		runConfig: RUN_CONFIG,
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		resumeHandler: async () => ({ action: 'continue' }),
	})

	return {
		generator,
		runStore,
		writes: vi.spyOn(runStore, 'writeRunMeta'),
		killOwner: vi.spyOn(jobs, 'killOwner'),
	}
}

/**
 * Consume the run until it is genuinely mid-flight, then break.
 *
 * Breaking at `checkpoint_created` is deliberate: by then the run has
 * started, a checkpoint is on disk and the store holds a durable run —
 * the state a host would find if it looked while the run was working.
 */
async function abandonMidFlight(): Promise<RunUnderTest> {
	const run = startRun()

	let sawRunInFlight = false
	for await (const event of run.generator) {
		if (event.type === 'checkpoint_created') {
			sawRunInFlight = true
			break
		}
	}

	// `break` only reaches the `finally` if the run actually got there.
	expect(sawRunInFlight).toBe(true)
	return run
}

/** Drive a run to its terminal value. A manual drain, because `for await`
 * discards the `Run` a settled generator returns. */
async function drain(run: RunUnderTest): Promise<Run> {
	const iterator = run.generator[Symbol.asyncIterator]()
	for (;;) {
		const next = await iterator.next()
		if (next.done) return next.value
	}
}

describe('a consumer that abandons the run', () => {
	it('runs the run’s teardown', async () => {
		const run = await abandonMidFlight()

		expect(run.killOwner).toHaveBeenCalledTimes(1)
	})

	it('leaves a terminal record rather than one that says the run is alive', async () => {
		const run = await abandonMidFlight()

		// `persist()` is what writes this, and before the fix it never ran:
		// the durable run was the one `init()` wrote — `idle` — which
		// `deriveRunStatus` reads back as `queued`, a run waiting to start.
		const status = run.runStore.snapshot().meta?.status
		expect(status).toBeDefined()
		expect(status).not.toBe('running')
		expect(isTerminalStatus(status ?? 'running')).toBe(true)
	})

	it('writes the durable record once for the abandonment and once for init', async () => {
		const run = await abandonMidFlight()

		// `init()` is the first write and the abandonment is the second.
		// Asserting the number rather than a boolean is what keeps a second
		// settle from slipping in beside the first.
		expect(run.writes.mock.calls.length).toBe(2)
	})

	it('leaves a run that completes writing exactly the same number of times', async () => {
		// The abandonment handling must not add a write where the run already
		// settled through `finalize()`.
		const run = startRun()

		const settled = await drain(run)

		expect(settled.status).toBe('completed')
		expect(run.writes.mock.calls.length).toBe(2)
		expect(run.killOwner).toHaveBeenCalledTimes(1)
	})
})

/**
 * A park is a promise to a human, and it outlives the consumer that walked
 * away: the run is resumable and somebody is still owed an answer.
 *
 * The abandonment path must not write a verdict over that. `deriveRunStatus`
 * reads a terminal status FIRST and the park second, so a parked run recorded
 * `cancelled` stops reporting `awaiting_hitl` — it reads as work somebody
 * gave up on, while the unanswered question is still on the record and the
 * checkpoint it belongs to is still the place a resume would start from.
 *
 * The race that produces it is one statement wide. `handleHITLDecision`
 * answers `pause` by emitting `run_paused` and draining it BEFORE it calls
 * `setStopReason('paused')`, so a consumer that breaks on that event leaves a
 * run with an outstanding park, `status: 'running'` and no stop reason at
 * all — the one instant where the in-memory state says nothing about the
 * question the durable state has already recorded.
 */
describe('a consumer that walks away while a human is being asked', () => {
	it('leaves the run parked, so the record still reads awaiting_hitl', async () => {
		const runStore = new InMemoryRunStore()
		const checkpointStore = new InMemoryCheckpointStore()
		const scope = {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			runId: generateRunId(),
		}

		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'echo',
				description: 'echoes its input',
				inputSchema: z.object({ text: z.string() }),
				category: 'shell',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async ({ text }) => ({ success: true, output: text }),
			}),
		)

		const generator = query({
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'echo', args: { text: 'ready' } }] }, { text: 'done' }],
			} as never),
			tools,
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: process.cwd(),
			runStore,
			checkpointStore,
			runId: scope.runId,
			tenantId: scope.tenantId,
			projectId: scope.projectId,
			sessionId: scope.sessionId,
			topicId: generateTopicId(),
			resumeHandler: async (request) =>
				// The cadence reaches a human; the tool review is approved so the
				// run gets to the phase that parks for one.
				request.type === 'iteration_checkpoint'
					? { action: 'pause', reason: 'not while I am reading this' }
					: { action: 'continue' },
			runConfig: RUN_CONFIG,
		})

		// Break where a host's socket dies. The park is already durable by
		// then — `awaitDecisionDurably` writes a `pause` before it returns it,
		// even when the answer arrived too fast for the park-record delay.
		let sawPause = false
		for await (const event of generator) {
			if (event.type === 'run_paused') {
				sawPause = true
				break
			}
		}
		expect(sawPause).toBe(true)

		// The question is still open, and still the read an approval queue is
		// built from.
		const park = await findPendingCheckpoint(checkpointStore, scope)
		expect(park?.pending?.request.type).toBe('iteration_checkpoint')

		// So the record must not have been given a verdict. Written as the
		// projection rather than as a status name, because the projection is
		// what a host reads and what the fix has to preserve.
		const status = runStore.snapshot().meta?.status ?? 'running'
		expect(status).not.toBe('cancelled')
		expect(isTerminalStatus(status)).toBe(false)
		expect(deriveRunStatus({ status, park: park?.pending })).toBe('awaiting_hitl')
	})
})
