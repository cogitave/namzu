// FLIPPED 2026-09-18, by the commit that fixed what this used to pin.
// The record a walked-away turn leaves behind is now terminal — `cancelled` —
// where this case used to pin the `idle` row `init()` wrote and nothing
// rewrote. Since the session log, that record is the turn's `turn_completed`.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Attributes,
	type Context,
	type Meter,
	type Span,
	type Tracer,
	metrics,
	trace,
} from '@opentelemetry/api'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { agentTurnSpanName } from '../../../telemetry/attributes.js'
import { resetRuntimeMetrics } from '../../../telemetry/metrics.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import { isTerminalStatus } from '../../../types/common/index.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { CheckpointId, UserQuestionData } from '../../../types/hitl/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, query } from '../index.js'
import { QuestionParkBinding } from '../question-park.js'
import { terminalRecords } from './support/session.js'

/**
 * A host that `break`s out of `for await (const event of query(...))` has to
 * leave the two halves of the turn agreeing.
 *
 * The generator's `finally` runs — Node calls `return()` on an abandoned
 * async generator — so every resource the turn borrowed is released: the
 * job registry's hold on its work, the sandbox, the question channel, the
 * task-store listener, the root span, the session's writer lease.
 *
 * The DURABLE record is the half that used to be missed. The terminal
 * record is written from `ResultAssembler.finalize()`, which sits after the
 * `finally`, on the far side of a `yield` nobody pulled — so the log kept a
 * turn with no verdict for a process that no longer existed. A queue reader
 * saw an active turn whose process was gone; a resume had no terminal state
 * to reconcile against; a dashboard counted it as in flight. `query()` now
 * settles that turn on the way out of an abandoned generator: one
 * `turn_completed` record, `cancelled`, and nothing on the stream — there is
 * no consumer left to emit an event to.
 *
 * Both halves are pinned here, which is why this file survived the fix with
 * its assertions flipped rather than replaced: the resources ARE released
 * (asserted), and the record IS updated (asserted). A turn never both
 * persists and is abandoned, and a turn never does neither.
 */

const dirs: string[] = []

afterEach(async () => {
	trace.disable()
	metrics.disable()
	resetRuntimeMetrics()
	await removeTempDirs(dirs)
	dirs.length = 0
})

interface Recorded {
	instrument: string
	value: number
	attributes: Attributes
}

function captureMetrics(recorded: Recorded[]): void {
	const instrument = (name: string) => ({
		add: (value: number, attributes: Attributes = {}) =>
			recorded.push({ instrument: name, value, attributes }),
		record: (value: number, attributes: Attributes = {}) =>
			recorded.push({ instrument: name, value, attributes }),
	})
	const meter = {
		createCounter: (n: string) => instrument(n),
		createHistogram: (n: string) => instrument(n),
		createUpDownCounter: (n: string) => instrument(n),
		createObservableGauge: (n: string) => instrument(n),
		createObservableCounter: (n: string) => instrument(n),
		createObservableUpDownCounter: (n: string) => instrument(n),
		addBatchObservableCallback: () => {},
		removeBatchObservableCallback: () => {},
	} as unknown as Meter
	metrics.setGlobalMeterProvider({ getMeter: () => meter })
}

/** Counts `end()` per span, and remembers which one was the turn's root. */
function recordingTracer(): {
	tracer: Tracer
	ended: () => number
	rootEnded: () => number
} {
	const counts = new Map<string, number>()
	const tracer = {
		startSpan: (name: string, _options?: unknown, _ctx?: Context) => {
			const self = {
				spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
				setAttribute: () => self,
				setAttributes: () => self,
				addEvent: () => self,
				setStatus: () => self,
				updateName: () => self,
				end: () => counts.set(name, (counts.get(name) ?? 0) + 1),
				isRecording: () => true,
				recordException: () => {},
				addLink: () => self,
				addLinks: () => self,
			} as unknown as Span
			return self
		},
		startActiveSpan: (() => {
			throw new Error('startActiveSpan does not hold context across yield; not used here')
		}) as never,
	} as unknown as Tracer
	return {
		tracer,
		ended: () => [...counts.values()].reduce((sum, n) => sum + n, 0),
		rootEnded: () => counts.get(agentTurnSpanName('Abandoned agent')) ?? 0,
	}
}

function echoToolset(): Toolset {
	return testToolset(
		defineTool({
			name: 'echo',
			description: 'echoes the text back',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'hi' }),
		}),
	)
}

describe('a host that walks away from the generator', () => {
	it('releases everything the turn borrowed, and leaves the record saying cancelled', async () => {
		const sessionId = generateSessionId()
		const sessionLog = new InMemorySessionLog({ sessionId })
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-abandoned-work-'))
		dirs.push(workingDirectory)
		const parks = new QuestionParkBinding()
		const recorded: Recorded[] = []
		captureMetrics(recorded)
		const { tracer, ended, rootEnded } = recordingTracer()
		trace.setGlobalTracerProvider({ getTracer: () => tracer })
		const sigtermBefore = process.listenerCount('SIGTERM')

		const gen = query({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }],
						finishReason: 'tool_calls',
					},
					{ text: 'never reached' },
				],
			}),
			toolsets: [echoToolset()],
			sessionLog,
			questionParks: parks,
			agentId: 'agent_abandoned',
			agentName: 'Abandoned agent',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory,
			projectId: generateProjectId(),
			sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			resumeHandler: autoApproveHandler,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
		} as unknown as QueryParams)

		// The walk-away: a host that has seen what it needed, or whose
		// consumer went away first.
		let pulled = 0
		const seen: SessionEvent[] = []
		for await (const event of gen) {
			seen.push(event)
			pulled += 1
			if (event.type === 'turn_started') break
		}
		expect(seen.some((event) => event.type === 'turn_started')).toBe(true)
		// And it was the FIRST event of the turn, so this host walked away after
		// exactly one pull. That is what makes the assertions below assertions
		// about abandonment: the `finally` released a turn that had not yet
		// finished an iteration, and the record it left behind is a terminal
		// record for that turn.
		expect(pulled).toBe(1)

		// ---- the `finally` ran ----
		// The root span was closed, and closed ONCE.
		expect(rootEnded()).toBe(1)
		// The duration metric was recorded, which happens nowhere but the
		// `finally` — so this is a second, independent proof the block ran.
		expect(recorded.filter((entry) => entry.instrument === 'namzu.turn.duration')).toHaveLength(1)
		// No process-level handler outlives the turn.
		expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
		// And the question channel is unbound, so a tool that outlived the turn
		// cannot write a question into it.
		const question: UserQuestionData = {
			questionId: 'after',
			question: 'anybody there?',
			options: [],
			multiSelect: false,
			allowFreeText: true,
		}
		const recordedPark: CheckpointId | null = await parks.record(question)
		expect(recordedPark).toBeNull()

		// ---- the record WAS updated ----
		// Without the settle the log would hold a turn with no verdict, which
		// reads as running — or, once its lease lapses, as interrupted — for a
		// turn that no longer exists. The abandonment settles it `cancelled`
		// rather than `failed`: nothing failed, the work was torn down under a
		// consumer that left, which is the same fact an abort records.
		const terminal = await terminalRecords(sessionLog)
		expect(terminal).toHaveLength(1)
		const [record] = terminal
		expect(record?.type).toBe('turn_completed')
		expect(record?.settlement.status).toBe('cancelled')
		expect(isTerminalStatus(record?.settlement.status ?? 'running')).toBe(true)
		// ...and names no error, because there was none to name.
		expect(record && 'error' in record).toBe(false)
		// It is written from live turn state on the way out, so the loop had
		// still not finished an iteration — which is what `turn_started`, the
		// event that made this host walk away, says about the turn.
		expect(record?.settlement.iterations).toBe(0)
		// And the session holds no active turn: the next turn may start.
		expect(await sessionLog.activeTurn()).toBeNull()
		// The stream is untouched: the host that left was handed nothing more.
		expect(seen).toHaveLength(1)
		// The span that DID close and the record that WAS written now agree:
		// both say the turn is over, which is the whole of what the fix bought.
		expect(ended()).toBeGreaterThan(0)
	})
})
