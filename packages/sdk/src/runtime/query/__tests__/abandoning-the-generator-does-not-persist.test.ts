// PINS CURRENT (DEFECTIVE) BEHAVIOUR — the run record is left running while its resources are gone.
// Scheduled for fix; this test is what the fix will flip.

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
 * A host that `break`s out of `for await (const event of query(...))` leaves
 * the two halves of the run disagreeing.
 *
 * The generator's `finally` runs — Node calls `return()` on an abandoned
 * async generator — so every resource the run borrowed is released: the
 * crash-save handlers, the job registry's hold on its work, the sandbox, the
 * question channel, the task-store listener, the root span. The DURABLE
 * record is not touched, because the only thing that writes the terminal
 * state is `ResultAssembler.finalize()`, and that sits after the `finally`,
 * on the far side of a `yield` nobody pulled.
 *
 * So the store keeps a run that says `running` — forever. A queue reader
 * sees an active run whose process is gone; a resume has no terminal state
 * to reconcile against; a dashboard counts it as in flight. Everything on
 * the record is consistent with work still happening, and nothing is.
 *
 * Both halves are pinned here, because a fix could move either one: the
 * resources ARE released (asserted), and the record is NOT updated
 * (asserted). The refactor must not change this silently in either
 * direction.
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
	it('releases everything the run borrowed, and leaves the record saying running', async () => {
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

		// ---- the record was NOT updated ----
		const runDir = store.getRunDir()
		expect(runDir).not.toBeNull()
		const meta = JSON.parse(await readFile(join(runDir as string, 'run.json'), 'utf8')) as Record<
			string,
			unknown
		>
		// `init()` writes this row before the first model call and
		// `finalize()` is the only thing that ever rewrites it. Abandoned, the
		// run stays on the record exactly as it was when it started.
		// Measured, and worse than the summary above: the row is the one
		// `init()` wrote BEFORE the first model call, and `markRunning()` does
		// not rewrite it — so the record says `idle` while the run has in fact
		// run a model call, executed a tool and released everything it held.
		expect(meta.status).toBe('idle')
		expect(meta.currentIteration).toBe(0)
		expect(meta.messageCount).toBe(0)
		expect(meta.endedAt).toBeUndefined()
		expect(meta.lastError).toBeUndefined()
		// And no terminal event was written either, so a log reader sees a run
		// that started and never ended.
		const types = await store.readEvents()
		expect(types.some((event) => event.type === 'run_completed')).toBe(false)
		expect(types.some((event) => event.type === 'run_failed')).toBe(false)
		// The span that DID close says the run finished, which is the other
		// half of the disagreement: the telemetry says it is over and the
		// durable record says it is not.
		expect(ended()).toBeGreaterThan(0)
	})
})
