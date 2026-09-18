// FLIPPED 2026-09-18, by the commit that fixed what this used to pin.
// The record a walked-away run leaves behind is now terminal — `cancelled` —
// where this case used to pin the `idle` row `init()` wrote and nothing
// rewrote.

import { mkdtemp, readFile } from 'node:fs/promises'
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
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import { agentRunSpanName } from '../../../telemetry/attributes.js'
import { resetRuntimeMetrics } from '../../../telemetry/metrics.js'
import { defineTool } from '../../../tools/defineTool.js'
import { type RunExecutionStatus, isTerminalStatus } from '../../../types/common/index.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { CheckpointId, UserQuestionData } from '../../../types/hitl/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, query } from '../index.js'
import { QuestionParkBinding } from '../question-park.js'

/**
 * A host that `break`s out of `for await (const event of query(...))` has to
 * leave the two halves of the run agreeing.
 *
 * The generator's `finally` runs — Node calls `return()` on an abandoned
 * async generator — so every resource the run borrowed is released: the
 * crash-save handlers, the job registry's hold on its work, the sandbox, the
 * question channel, the task-store listener, the root span.
 *
 * The DURABLE record is the half that used to be missed. `persist()` is
 * reached from `ResultAssembler.finalize()`, which sits after the `finally`,
 * on the far side of a `yield` nobody pulled — so the store kept whatever
 * `init()` wrote: a non-terminal row for a run that no longer existed. A
 * queue reader saw an active run whose process was gone; a resume had no
 * terminal state to reconcile against; a dashboard counted it as in flight.
 * `query()` now settles that record on the way out of an abandoned
 * generator, marking the run cancelled and persisting it, and writes nothing
 * else — there is no consumer left to emit an event to.
 *
 * Both halves are pinned here, which is why this file survived the fix with
 * its assertions flipped rather than replaced: the resources ARE released
 * (asserted), and the record IS updated (asserted). A run never both
 * persists and is abandoned, and a run never does neither.
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

/** Counts `end()` per span, and remembers which one was the run's root. */
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
		rootEnded: () => counts.get(agentRunSpanName('Abandoned agent')) ?? 0,
	}
}

function echoRegistry(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
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
	return tools
}

describe('a host that walks away from the generator', () => {
	it('releases everything the run borrowed, and leaves the record saying cancelled', async () => {
		const baseDir = await mkdtemp(join(tmpdir(), 'namzu-abandoned-'))
		dirs.push(baseDir)
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-abandoned-work-'))
		dirs.push(workingDirectory)
		const store = new RunDiskStore({ baseDir })
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
			tools: echoRegistry(),
			runStore: store,
			emergencySave: true,
			questionParks: parks,
			agentId: 'agent_abandoned',
			agentName: 'Abandoned agent',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory,
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
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
			runConfig: {
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
		const seen: RunEvent[] = []
		for await (const event of gen) {
			seen.push(event)
			pulled += 1
			if (event.type === 'run_started') break
		}
		expect(seen.some((event) => event.type === 'run_started')).toBe(true)
		// And it was the FIRST event of the run, so this host walked away after
		// exactly one pull. That is what makes the assertions below assertions
		// about abandonment: the `finally` released a run that had not yet
		// finished an iteration, and the record it left behind is a terminal
		// row for that run rather than the one `init()` wrote.
		expect(pulled).toBe(1)

		// ---- the `finally` ran ----
		// The root span was closed, and closed ONCE.
		expect(rootEnded()).toBe(1)
		// The duration metric was recorded, which happens nowhere but the
		// `finally` — so this is a second, independent proof the block ran.
		expect(recorded.filter((entry) => entry.instrument === 'namzu.run.duration')).toHaveLength(1)
		// The crash-save handlers were removed, so the abandoned run is not
		// the process's crash target for the rest of its life.
		expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
		// And the question channel is unbound, so a tool that outlived the run
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
		const runDir = store.getRunDir()
		expect(runDir).not.toBeNull()
		const meta = JSON.parse(await readFile(join(runDir as string, 'run.json'), 'utf8')) as Record<
			string,
			unknown
		>
		// `init()` wrote this row before the first model call and nothing else
		// rewrote it, so it used to say `idle` — which `deriveRunStatus` reads
		// back as `queued`, a run waiting to start, for one that no longer
		// exists. The abandonment now marks the run cancelled and persists it,
		// so what a host rebuilds from the store is a run that is over.
		// `cancelled` rather than `failed`: nothing failed, the work was torn
		// down under a consumer that left, which is the same fact
		// `markCancelled` already records when an abort tears a run down.
		expect(meta.status).toBe('cancelled')
		expect(isTerminalStatus(meta.status as RunExecutionStatus)).toBe(true)
		// The verdict carries the moment it was reached...
		expect(meta.endedAt).toBeGreaterThan(0)
		// ...and names no error, because there was none to name.
		expect(meta.lastError).toBeUndefined()
		// The row is the one the abandonment wrote, not the one `init()` left:
		// an `endedAt` exists only on a settled record, which is the precise
		// thing `idle` could not have carried. It is written from live run
		// state on the way out, so the loop had still not finished an
		// iteration — which is what `run_started`, the event that made this
		// host walk away, says about the run.
		expect(meta.currentIteration).toBe(0)
		// `messageCount` is deliberately no longer asserted. It read 0 only
		// because the row was the untouched one `init()` had written, so
		// pinning it would now pin an init-timing detail rather than the
		// contract this file exists for.
		// No terminal EVENT was written, and that stays true: there is no
		// consumer left to receive one, so the stream is untouched and only
		// the durable record moved.
		const types = await store.readEvents()
		expect(types.some((event) => event.type === 'run_completed')).toBe(false)
		expect(types.some((event) => event.type === 'run_failed')).toBe(false)
		// The span that DID close and the row that WAS written now agree: both
		// say the run is over, which is the whole of what the fix bought.
		expect(ended()).toBeGreaterThan(0)
	})
})
