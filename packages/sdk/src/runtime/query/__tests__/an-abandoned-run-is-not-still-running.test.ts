import { type MockInstance, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import { isTerminalStatus } from '../../../types/common/index.js'
import { deriveTurnStatus } from '../../../types/session/derive-status.js'
import type { SessionEvent, Turn } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { drainQuery, query } from '../index.js'
import { terminalRecords } from './support/session.js'

/**
 * A consumer that walks away leaves a run that is over, and the durable
 * record has to say so.
 *
 * `persist()` is reached from exactly one place — `ResultAssembler.finalize()`
 * — and that call sits after the `try/catch/finally` rather than inside it.
 * `for await (… ) break` and `gen.return()` both run the `finally` (jobs
 * killed, sandbox destroyed, span ended, duration recorded) and both skip
 * everything after it. The run is torn down and the log holds no terminal
 * record, so a host rebuilding its view from the log sees work that is not
 * happening.
 *
 * `drainQuery` drains to completion and never abandons, so this is the
 * `for await` surface only.
 */

registerMock()

const RUN_CONFIG = { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 4 }

interface RunUnderTest {
	generator: AsyncGenerator<SessionEvent, Turn>
	sessionLog: InMemorySessionLog
	/** The teardown the run's `finally` block performs. */
	killOwner: MockInstance
}

function startRun(): RunUnderTest {
	const sessionId = generateSessionId()
	const sessionLog = new InMemorySessionLog({ sessionId })
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
		sessionLog,
		backgroundJobs: jobs,
		turnConfig: RUN_CONFIG,
		projectId: generateProjectId(),
		sessionId,
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		resumeHandler: async () => ({ action: 'continue' }),
	})

	return {
		generator,
		sessionLog,
		killOwner: vi.spyOn(jobs, 'killOwner'),
	}
}

/**
 * Consume the run until it is genuinely mid-flight, then break.
 *
 * Breaking at `checkpoint_created` is deliberate: by then the run has
 * started, a checkpoint is committed and the log holds a running turn —
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
 * discards the `Turn` a settled generator returns. */
async function drain(run: RunUnderTest): Promise<Turn> {
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

		// Without the settle the log would hold a turn with no terminal
		// record, which reads as running (or, once its lease lapses, as
		// interrupted) — work waiting to continue.
		const [terminal] = await terminalRecords(run.sessionLog)
		const status = terminal?.settlement.status
		expect(status).toBeDefined()
		expect(isTerminalStatus(status ?? 'running')).toBe(true)
		expect(await run.sessionLog.activeTurn()).toBeNull()
	})

	it('writes exactly one terminal record for the abandonment', async () => {
		const run = await abandonMidFlight()

		// Asserting the number rather than a boolean is what keeps a second
		// settle from slipping in beside the first.
		expect(await terminalRecords(run.sessionLog)).toHaveLength(1)
	})

	it('leaves a run that completes writing exactly the same number of times', async () => {
		// The abandonment handling must not add a write where the run already
		// settled through `finalize()`.
		const run = startRun()

		const settled = await drain(run)

		expect(settled.status).toBe('completed')
		expect(await terminalRecords(run.sessionLog)).toHaveLength(1)
		expect(run.killOwner).toHaveBeenCalledTimes(1)
	})
})

/**
 * A park is a promise to a human, and it outlives the consumer that walked
 * away: the run is resumable and somebody is still owed an answer.
 *
 * The abandonment path must not write a verdict over that. `deriveTurnStatus`
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
		const scope = {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
		}
		const sessionLog = new InMemorySessionLog({ sessionId: scope.sessionId })

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
			sessionLog,
			turnId: scope.turnId,
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
			turnConfig: RUN_CONFIG,
		})

		// Break where a host's socket dies. The park is already durable by
		// then — `awaitDecisionDurably` writes a `pause` before it returns it,
		// even when the answer arrived too fast for the park-record delay.
		let sawPause = false
		for await (const event of generator) {
			if (event.type === 'turn_paused') {
				sawPause = true
				break
			}
		}
		expect(sawPause).toBe(true)

		// The question is still open, and still the read an approval queue is
		// built from.
		const park = await findPendingCheckpoint(sessionLog, { turnId: scope.turnId })
		expect(park?.pending.request.type).toBe('iteration_checkpoint')

		// So the turn must not have been given a verdict: no terminal record,
		// and the log still holds it as the session's paused turn. Written
		// also as the projection, because that is what a host reads and what
		// the fix has to preserve.
		expect(await terminalRecords(sessionLog)).toEqual([])
		expect((await sessionLog.activeTurn())?.state).toBe('paused')
		expect(deriveTurnStatus({ status: 'running', park: park?.pending })).toBe('awaiting_hitl')
	})
})

describe('a new turn named by the host', () => {
	it('is refused when the session already holds a turn under that id', async () => {
		const sessionId = generateSessionId()
		const sessionLog = new InMemorySessionLog({ sessionId })
		const turnId = generateTurnId()
		const base = {
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] } as never),
			tools: new ToolRegistry(),
			agentId: 'a',
			agentName: 'A',
			workingDirectory: process.cwd(),
			sessionLog,
			turnConfig: RUN_CONFIG,
			projectId: generateProjectId(),
			sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			resumeHandler: async () => ({ action: 'continue' as const }),
		}
		const first = await drainQuery({ ...base, turnId, messages: [{ role: 'user', content: 'go' }] })
		expect(first.status).toBe('completed')

		// Two `turn_started` records under one id would read as one turn.
		await expect(
			drainQuery({ ...base, turnId, messages: [{ role: 'user', content: 'again' }] }),
		).rejects.toThrow(/already exists/)
		expect(
			(await sessionLog.readAll()).entries.filter((entry) => entry.record.type === 'turn_started'),
		).toHaveLength(1)
	})
})
