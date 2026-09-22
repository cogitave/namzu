import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostLogger } from '../../../__fixtures__/host-logger.js'
import { GENAI, NAMZU } from '../../../constants/telemetry/index.js'
import { InMemorySessionTokenBudgetStore } from '../../../store/budget/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { TurnConfig } from '../../../types/session/index.js'
import { NOOP_LOGGER } from '../../../utils/log/create-logger.js'
import { type LogRecord, type LogSink, createLogger } from '../../../utils/log/index.js'
import { __resetProcessSinkForTests, installProcessSink } from '../../../utils/log/process-sink.js'
import { TurnContextFactory } from '../context.js'
import type { SessionStorage } from '../session-storage.js'
import { checkpointStoreFor } from './support/session.js'

/** Storage for an in-memory session, or for one whose log sits in `sessionDir`. */
function storage(sessionId: SessionId, sessionDir?: string): SessionStorage {
	const log = new InMemorySessionLog({ sessionId })
	return {
		log,
		paths: undefined,
		sessionDir,
		checkpoints: checkpointStoreFor(log),
		tokenBudget: new InMemorySessionTokenBudgetStore(),
		children: undefined,
	}
}

function mockProvider(): LLMProvider {
	return {
		id: 'mock',
		supports: () => true,
		chat: async () => ({ message: { role: 'assistant', content: '' } }),
	} as unknown as LLMProvider
}

function buildConfig(overrides: Partial<Parameters<typeof TurnContextFactory.build>[0]> = {}) {
	const sessionId = 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede' as SessionId
	const topicId = '4bd72c65-bcc9-475c-8d7c-27d622df04e8' as TopicId
	const projectId = '08c9b09c-4412-478c-878b-dc94927c760f' as ProjectId
	const tenantId = 'a8e039fb-e8d3-4206-9ed8-4cb17d5d8222' as TenantId
	const turnConfig: TurnConfig = {
		model: 'test',
		tokenBudget: 1_000,
		timeoutMs: 5_000,
	}

	return {
		agentId: 'agent-1',
		agentName: 'agent-1',
		turnConfig,
		provider: mockProvider(),
		messages: [],
		sessionId,
		topicId,
		projectId,
		tenantId,
		turnId: 'b1f6e0d4-2f0a-4a53-9d3c-6f3f6f3c1a11' as TurnId,
		storage: storage(sessionId),
		workingDirectory: '/tmp/run-context-test',
		...overrides,
	}
}

describe('TurnContextFactory.build', () => {
	it('requires sessionId, topicId, projectId, tenantId and returns them on the context', () => {
		const cfg = buildConfig()
		const ctx = TurnContextFactory.build(cfg)

		expect(ctx.sessionId).toBe(cfg.sessionId)
		expect(ctx.topicId).toBe(cfg.topicId)
		expect(ctx.projectId).toBe(cfg.projectId)
		expect(ctx.tenantId).toBe(cfg.tenantId)
	})

	it('spills tool results beside the session log', () => {
		const sessionDir = join('/home', 'projects', 'demo', 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede')
		const cfg = buildConfig()
		const ctx = TurnContextFactory.build({ ...cfg, storage: storage(cfg.sessionId, sessionDir) })

		expect(ctx.toolResultsDir).toBe(join(sessionDir, 'tool-results'))
	})

	it('has nowhere to spill for a session held in memory', () => {
		const ctx = TurnContextFactory.build(buildConfig())

		expect(ctx.toolResultsDir).toBeUndefined()
	})

	it('seeds TurnRecorder with propagated sessionId/topicId/tenantId/projectId', () => {
		const cfg = buildConfig()
		const ctx = TurnContextFactory.build(cfg)

		expect(ctx.recorder.sessionId).toBe(cfg.sessionId)
		expect(ctx.recorder.topicId).toBe(cfg.topicId)
		expect(ctx.recorder.tenantId).toBe(cfg.tenantId)
		expect(ctx.recorder.projectId).toBe(cfg.projectId)
	})

	it('uses the turnId supplied by the caller', () => {
		const turnId = '32dac363-0593-4feb-b737-d1c7a195a51b' as TurnId
		const ctx = TurnContextFactory.build(buildConfig({ turnId }))
		expect(ctx.turnId).toBe(turnId)
		expect(ctx.recorder.turnId).toBe(turnId)
	})

	it("carries the caller's stop reason across into the turn", () => {
		const host = new AbortController()
		const ctx = TurnContextFactory.build(buildConfig({ signal: host.signal }))

		host.abort(new Error('nightly window closed'))

		expect(ctx.abortController.signal.aborted).toBe(true)
		expect((ctx.abortController.signal.reason as Error)?.message).toBe('nightly window closed')
	})

	it("mirrors a caller's stop when it happened before the context existed", () => {
		const host = new AbortController()
		const reason = new Error('authority was already withdrawn')
		host.abort(reason)

		const ctx = TurnContextFactory.build(buildConfig({ signal: host.signal }))

		expect(ctx.abortController.signal.aborted).toBe(true)
		expect(ctx.abortController.signal.reason).toBe(reason)
	})

	it('still aborts when the caller gave no reason', () => {
		const host = new AbortController()
		const ctx = TurnContextFactory.build(buildConfig({ signal: host.signal }))

		host.abort()

		expect(ctx.abortController.signal.aborted).toBe(true)
	})
})

describe('TurnContextFactory.buildLogger', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it("binds namzu.turn.id and the rest of the turn scope onto the host's logger", () => {
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }

		const cfg = buildConfig()
		const turnId = 'ae683305-c07d-4685-a4db-e1aef4680237' as TurnId
		const log = TurnContextFactory.buildLogger({
			agentName: cfg.agentName,
			turnConfig: { ...cfg.turnConfig, logger: hostLogger(sink) },
			turnId,
			sessionId: cfg.sessionId,
			topicId: cfg.topicId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		})
		log.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.attributes[NAMZU.TURN_ID]).toBe(turnId)
		expect(records[0]?.attributes[GENAI.AGENT_NAME]).toBe(cfg.agentName)
		expect(records[0]?.attributes[NAMZU.SESSION_ID]).toBe(cfg.sessionId)
		expect(records[0]?.attributes[NAMZU.THREAD_ID]).toBe(cfg.topicId)
		expect(records[0]?.attributes[NAMZU.PROJECT_ID]).toBe(cfg.projectId)
		expect(records[0]?.attributes[NAMZU.TENANT_ID]).toBe(cfg.tenantId)
		// Read off a REAL record, not a mock. `buildLogger` binds the scope
		// through SCOPE_ATTRIBUTE, and a `child()` implementation that copied
		// the reserved key into attributes instead of consuming it into the
		// record's scope would leave this at the host logger's own scope.
		expect(records[0]?.scope.name).toBe('runtime/query')
	})

	it('emits nothing at all when the host supplied no logger, process sink installed or not', () => {
		// LOG-20's whole claim, in one assertion. `turnConfig.logger` absent
		// used to mean "resolve the process-wide root", so a library the host
		// never handed a logger wrote to the host's stderr — and installing a
		// process sink silently rerouted SDK internals the host never asked to
		// see. `resolveLogger(undefined)` is `NOOP_LOGGER` now: no logger in,
		// nothing out. Reintroducing any global fallback fails here.
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		const cfg = buildConfig()
		TurnContextFactory.buildLogger({
			agentName: cfg.agentName,
			turnConfig: cfg.turnConfig,
			turnId: '892557f8-96dc-4ce9-b958-ec6917ddad2c' as TurnId,
			sessionId: cfg.sessionId,
			topicId: cfg.topicId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		}).info('hello')

		expect(records).toHaveLength(0)
		// And the discard is COUNTED, which is the half that distinguishes
		// "silenced" from "never happened" — `NOOP_LOGGER` runs at `debug` on
		// purpose so a host can still see that N calls were thrown away.
		expect(NOOP_LOGGER.counters.dropped).toBeGreaterThan(0)
	})

	it('derives from the host-supplied turnConfig.logger, not from any other source', () => {
		// A capturing sink installed as the process DEFAULT — proves nothing by
		// itself, since every logger in this test would be reachable from it
		// too if buildLogger ignored the host's own logger. The marker logger
		// below points at a SEPARATE sink `installProcessSink` never touches,
		// so a record landing there and not here is the only way to tell
		// "derived from the host's logger" apart from "derived from the root
		// that happens to look the same".
		const rootRecords: LogRecord[] = []
		const rootSink: LogSink = { emit: (record) => rootRecords.push(record) }
		installProcessSink(rootSink, 'debug', { replace: true })

		const markerRecords: LogRecord[] = []
		const markerSink: LogSink = { emit: (record) => markerRecords.push(record) }
		const marker = createLogger({
			sink: markerSink,
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope: 'namzu',
		})

		const cfg = buildConfig()
		const log = TurnContextFactory.buildLogger({
			agentName: cfg.agentName,
			turnConfig: { ...cfg.turnConfig, logger: marker },
			turnId: 'b177e5bf-5b2a-4006-83df-04313ca307d7' as TurnId,
			sessionId: cfg.sessionId,
			topicId: cfg.topicId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		})
		log.info('hello')

		expect(markerRecords).toHaveLength(1)
		expect(rootRecords).toHaveLength(0)
	})
})

describe('TurnContextFactory.build accepts a pre-built logger', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it('uses config.log unchanged instead of constructing its own via buildLogger', () => {
		const cfg = buildConfig()
		const turnId = 'd4f86af4-7306-4cd3-bafa-4afdb81a3c25' as TurnId
		const preBuilt = TurnContextFactory.buildLogger({
			agentName: cfg.agentName,
			turnConfig: cfg.turnConfig,
			turnId,
			sessionId: cfg.sessionId,
			topicId: cfg.topicId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		})

		const ctx = TurnContextFactory.build(buildConfig({ turnId, log: preBuilt }))

		expect(ctx.log).toBe(preBuilt)
	})

	it('falls back to buildLogger — same correlated shape as the direct call — when config.log is absent', () => {
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }

		const turnId = '05a0d6cb-6960-41b7-9e67-ed4dbed4e3cb' as TurnId
		const base = buildConfig({ turnId })
		const ctx = TurnContextFactory.build({
			...base,
			turnConfig: { ...base.turnConfig, logger: hostLogger(sink) },
		})
		ctx.log.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.attributes[NAMZU.TURN_ID]).toBe(turnId)
	})
})
