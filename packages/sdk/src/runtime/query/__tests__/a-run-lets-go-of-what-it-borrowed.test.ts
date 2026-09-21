import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Attributes, type Meter, metrics } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { NAMZU } from '../../../constants/telemetry/index.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import { resetRuntimeMetrics } from '../../../telemetry/metrics.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { CheckpointId, UserQuestionData } from '../../../types/hitl/index.js'
import type { TaskEvent } from '../../../types/task/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { QuestionParkBinding } from '../question-park.js'
import type { TurnStateScope } from '../turn-state.js'

/**
 * Everything a run borrows is released in its `finally`, and four of those
 * releases had never been observed in place.
 *
 * `questionParks.unbind()` is half covered — `tool-pause-resume.test.ts`
 * asserts `bind` and `unbind` were CALLED. What it does not assert is the
 * consequence the call exists for: a tool that outlives the run can no
 * longer write a question into a finished run's store. That is the
 * difference between a stale handle and a corrupted transcript.
 *
 * The other three had nothing at all. A `SIGTERM` handler left installed
 * keeps a settled run as the process's crash target; a task-store listener
 * left attached writes `task_created` into a run that has ended; a run whose
 * duration is never recorded is missing from the one metric that answers
 * "how long do these take, and how do they end".
 */

const SCOPE: TurnStateScope = {
	turnId: fixtureId.run('cleanup'),
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
	topicId: generateTopicId(),
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function dirWith(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
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

async function baseParams(overrides: Record<string, unknown>): Promise<QueryParams> {
	return {
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
		tools: echoRegistry(),
		agentId: 'agent_cleanup',
		agentName: 'Cleanup agent',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: await dirWith('namzu-cleanup-work-'),
		turnId: SCOPE.runId,
		tenantId: SCOPE.tenantId,
		projectId: SCOPE.projectId,
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		resumeHandler: autoApproveHandler,
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		...overrides,
	} as QueryParams
}

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

beforeEach(() => {
	resetRuntimeMetrics()
})

afterEach(() => {
	metrics.disable()
	resetRuntimeMetrics()
})

describe('the crash-save handlers a run installs', () => {
	it('are gone once the run has settled', async () => {
		const before = process.listenerCount('SIGTERM')

		await drainQuery(
			await baseParams({
				runStore: new RunDiskStore({ baseDir: await dirWith('namzu-cleanup-') }),
				// Opt-in, and the only way this manager is ever constructed.
				emergencySave: true,
			}),
		)

		// A handler left installed suppresses Node's default termination and
		// keeps a settled, `WeakRef`'d run as the process's crash target for
		// the rest of the process's life.
		expect(process.listenerCount('SIGTERM')).toBe(before)
		expect(process.listenerCount('SIGINT')).toBe(0)
	})
})

describe('the task-store listener a run attaches', () => {
	it('stops delivering into a run that has ended', async () => {
		const store = new InMemoryTaskStore()
		const seen: TaskEvent[] = []
		const originalOn = store.on.bind(store)
		// Watch what the RUN's own listener is handed by wrapping the store's
		// fan-out. An unsubscribe that ran leaves `seen` where it was; one
		// that did not writes `task_created` into a finished run.
		store.on = (listener) =>
			originalOn(async (event) => {
				seen.push(event)
				await listener(event)
			})

		await drainQuery(
			await baseParams({
				runStore: new RunDiskStore({ baseDir: await dirWith('namzu-cleanup-tasks-') }),
				taskStore: store,
			}),
		)

		const before = seen.length
		// A task created AFTER the run settles, by a tool or a host that
		// outlived it. The run must not hear about it.
		await store.create({ runId: SCOPE.runId, subject: 'work raised after the run ended' })
		await new Promise<void>((resolve) => setImmediate(resolve))

		expect(seen.length).toBe(before)
	})
})

describe('the question channel a run binds', () => {
	it('cannot take a later question into a run that has ended', async () => {
		const store = new InMemoryCheckpointStore()
		// One binding, shared the way a long-lived tool registry shares one:
		// the tool that asks is built before the run exists and outlives it.
		const parks = new QuestionParkBinding()

		await drainQuery(
			await baseParams({
				checkpointStore: store,
				questionParks: parks,
			}),
		)

		const before = (await store.listCheckpoints(SCOPE)).length
		const question: UserQuestionData = {
			questionId: 'call_after_the_run',
			question: 'anybody there?',
			options: [],
			multiSelect: false,
			allowFreeText: true,
		}
		const recorded: CheckpointId | null = await parks.record(question)

		// Unbound, the recorder returns `null` and writes nothing — the tool
		// that asked is still served in-process, and the finished run's store
		// is left alone. Without the `unbind` this writes a park into a run
		// nobody is driving, and an approval queue serves it forever.
		expect(recorded).toBeNull()
		expect((await store.listCheckpoints(SCOPE)).length).toBe(before)
	})
})

describe('the duration a run records as it settles', () => {
	it('is recorded under the status the run actually ended with', async () => {
		const recorded: Recorded[] = []
		captureMetrics(recorded)

		const run = await drainQuery(
			await baseParams({
				runStore: new RunDiskStore({ baseDir: await dirWith('namzu-cleanup-duration-') }),
			}),
		)

		const duration = recorded.filter((entry) => entry.instrument === 'namzu.turn.duration')
		expect(duration).toHaveLength(1)
		// Keyed by HOW it settled, not merely that it did: a cancelled run and
		// a run that hit its budget have very different duration
		// distributions, and averaging them together describes neither.
		expect(duration[0]?.attributes[NAMZU.TURN_STATUS]).toBe('completed')
		expect(run.status).toBe('completed')
		// Seconds, not milliseconds — the instrument declares `unit: 's'`.
		expect(duration[0]?.value).toBeLessThan(60)
	})

	it('records a cancelled run under cancelled', async () => {
		const recorded: Recorded[] = []
		captureMetrics(recorded)
		const caller = new AbortController()

		await drainQuery(
			await baseParams({
				runStore: new RunDiskStore({ baseDir: await dirWith('namzu-cleanup-duration-') }),
				signal: caller.signal,
			}),
			() => {
				if (!caller.signal.aborted) caller.abort()
			},
		)

		const duration = recorded.filter((entry) => entry.instrument === 'namzu.turn.duration')
		// The negative control for the case above: if the status were a
		// constant, two runs that settled differently could not disagree.
		expect(duration[0]?.attributes[NAMZU.TURN_STATUS]).toBe('cancelled')
	})
})
