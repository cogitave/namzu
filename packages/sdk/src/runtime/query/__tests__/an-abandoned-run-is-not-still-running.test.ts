import { type MockInstance, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import { isTerminalStatus } from '../../../types/common/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
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
