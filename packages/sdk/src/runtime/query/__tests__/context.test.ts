import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostLogger } from '../../../__fixtures__/host-logger.js'
import { GENAI, NAMZU } from '../../../constants/telemetry/index.js'
import {
	DefaultFilesystemMigrator,
	loggingMigrationSink,
} from '../../../session/migration/index.js'
import { DefaultPathBuilder, type PathBuilder } from '../../../session/workspace/path-builder.js'
import { posix } from '../../../test-support/paths.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { AgentRunConfig } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { NOOP_LOGGER } from '../../../utils/log/create-logger.js'
import { type LogRecord, type LogSink, createLogger } from '../../../utils/log/index.js'
import { __resetProcessSinkForTests, installProcessSink } from '../../../utils/log/process-sink.js'
import { RunContextFactory } from '../context.js'

function mockProvider(): LLMProvider {
	return {
		id: 'mock',
		supports: () => true,
		chat: async () => ({ message: { role: 'assistant', content: '' } }),
	} as unknown as LLMProvider
}

function buildConfig(overrides: Partial<Parameters<typeof RunContextFactory.build>[0]> = {}) {
	const sessionId = 'ses_test' as SessionId
	const topicId = 'top_test' as TopicId
	const projectId = 'prj_test' as ProjectId
	const tenantId = 'tnt_test' as TenantId
	const runConfig: AgentRunConfig = {
		model: 'test',
		tokenBudget: 1_000,
		timeoutMs: 5_000,
	}

	return {
		agentId: 'agent-1',
		agentName: 'agent-1',
		runConfig,
		provider: mockProvider(),
		messages: [],
		sessionId,
		topicId,
		projectId,
		tenantId,
		workingDirectory: '/tmp/run-context-test',
		...overrides,
	}
}

describe('RunContextFactory.build', () => {
	it('requires sessionId, topicId, projectId, tenantId and returns them on the context', () => {
		const cfg = buildConfig()
		const ctx = RunContextFactory.build(cfg)

		expect(ctx.sessionId).toBe(cfg.sessionId)
		expect(ctx.topicId).toBe(cfg.topicId)
		expect(ctx.projectId).toBe(cfg.projectId)
		expect(ctx.tenantId).toBe(cfg.tenantId)
	})

	it('uses the injected PathBuilder to resolve the output dir (no hardcoded .namzu/threads)', () => {
		const pathBuilderMock: PathBuilder = {
			rootDir: vi.fn(() => '/mock/root'),
			projectDir: vi.fn((pid) => `/mock/root/projects/${pid}`),
			sessionDir: vi.fn((pid, sid) => `/mock/root/projects/${pid}/sessions/${sid}`),
			subSessionDir: vi.fn(),
			runDir: vi.fn(),
		}

		const cfg = buildConfig({ pathBuilder: pathBuilderMock })
		const ctx = RunContextFactory.build(cfg)

		expect(pathBuilderMock.sessionDir).toHaveBeenCalledWith(cfg.projectId, cfg.sessionId)
		expect(ctx.outputDir).toBe(`/mock/root/projects/${cfg.projectId}/sessions/${cfg.sessionId}`)
		// Legacy hardcoded path must not leak.
		expect(ctx.outputDir).not.toContain('.namzu/threads')
	})

	it('falls back to DefaultPathBuilder rooted at {cwd}/.namzu when no pathBuilder is provided', () => {
		const cfg = buildConfig()
		const ctx = RunContextFactory.build(cfg)

		// Layout lives under projects/{pid}/sessions/{sid} — no `.namzu/threads/`.
		expect(posix(ctx.outputDir)).toContain('/.namzu/projects/prj_test/sessions/ses_test')
		expect(ctx.outputDir).not.toContain('threads')
	})

	it('seeds RunPersistence with propagated sessionId/topicId/tenantId/projectId', () => {
		const cfg = buildConfig()
		const ctx = RunContextFactory.build(cfg)

		expect(ctx.runMgr.sessionId).toBe(cfg.sessionId)
		expect(ctx.runMgr.topicId).toBe(cfg.topicId)
		expect(ctx.runMgr.tenantId).toBe(cfg.tenantId)
		expect(ctx.runMgr.projectId).toBe(cfg.projectId)
	})

	it('reuses the runId supplied by the caller', () => {
		const runId = 'run_fixed' as RunId
		const ctx = RunContextFactory.build(buildConfig({ runId }))
		expect(ctx.runId).toBe(runId)
	})

	it('DefaultPathBuilder lays out runs under sessions/{sessionId}/runs', () => {
		const builder = new DefaultPathBuilder('/base/.namzu')
		const runDir = builder.runDir('prj_x' as ProjectId, 'ses_y' as SessionId, 'run_z' as RunId)
		expect(posix(runDir)).toBe('/base/.namzu/projects/prj_x/sessions/ses_y/runs/run_z')
	})

	it("carries the caller's stop reason across into the run", () => {
		const host = new AbortController()
		const ctx = RunContextFactory.build(buildConfig({ signal: host.signal }))

		host.abort(new Error('nightly window closed'))

		expect(ctx.abortController.signal.aborted).toBe(true)
		expect((ctx.abortController.signal.reason as Error)?.message).toBe('nightly window closed')
	})

	it('still aborts when the caller gave no reason', () => {
		const host = new AbortController()
		const ctx = RunContextFactory.build(buildConfig({ signal: host.signal }))

		host.abort()

		expect(ctx.abortController.signal.aborted).toBe(true)
	})
})

describe('RunContextFactory.buildLogger', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it("binds namzu.run.id and the rest of the run scope onto the host's logger", () => {
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }

		const cfg = buildConfig()
		const runId = 'run_built' as RunId
		const log = RunContextFactory.buildLogger({
			agentName: cfg.agentName,
			runConfig: { ...cfg.runConfig, logger: hostLogger(sink) },
			runId,
			sessionId: cfg.sessionId,
			topicId: cfg.topicId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		})
		log.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.attributes[NAMZU.RUN_ID]).toBe(runId)
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
		// LOG-20's whole claim, in one assertion. `runConfig.logger` absent
		// used to mean "resolve the process-wide root", so a library the host
		// never handed a logger wrote to the host's stderr — and installing a
		// process sink silently rerouted SDK internals the host never asked to
		// see. `resolveLogger(undefined)` is `NOOP_LOGGER` now: no logger in,
		// nothing out. Reintroducing any global fallback fails here.
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		const cfg = buildConfig()
		RunContextFactory.buildLogger({
			agentName: cfg.agentName,
			runConfig: cfg.runConfig,
			runId: 'run_silent' as RunId,
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

	it('derives from the host-supplied runConfig.logger, not from any other source', () => {
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
		const log = RunContextFactory.buildLogger({
			agentName: cfg.agentName,
			runConfig: { ...cfg.runConfig, logger: marker },
			runId: 'run_marker' as RunId,
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

describe('RunContextFactory.build accepts a pre-built logger', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it('uses config.log unchanged instead of constructing its own via buildLogger', () => {
		const cfg = buildConfig()
		const runId = 'run_prebuilt' as RunId
		const preBuilt = RunContextFactory.buildLogger({
			agentName: cfg.agentName,
			runConfig: cfg.runConfig,
			runId,
			sessionId: cfg.sessionId,
			topicId: cfg.topicId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		})

		const ctx = RunContextFactory.build(buildConfig({ runId, log: preBuilt }))

		expect(ctx.log).toBe(preBuilt)
	})

	it('falls back to buildLogger — same correlated shape as the direct call — when config.log is absent', () => {
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }

		const runId = 'run_auto' as RunId
		const base = buildConfig({ runId })
		const ctx = RunContextFactory.build({
			...base,
			runConfig: { ...base.runConfig, logger: hostLogger(sink) },
		})
		ctx.log.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.attributes[NAMZU.RUN_ID]).toBe(runId)
	})
})

describe('RunContextFactory.ensureMigrated', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it('defaults to NOOP_FILESYSTEM_MIGRATION_SINK: migrating a legacy layout logs nothing', async () => {
		// Two roots, one assertion each way. Asserting only the empty half
		// would pass on a migration that never ran, on a sink wired to
		// nothing, and — since LOG-20 — on absolutely any default at all,
		// because no logger reaches a component that was not handed one. The
		// control root proves the same migration DOES narrate when the caller
		// asks for it, so the empty half means "this default is silent".
		const quiet = await mkdtemp(join(tmpdir(), 'namzu-ensure-migrated-'))
		const loud = await mkdtemp(join(tmpdir(), 'namzu-ensure-migrated-loud-'))
		try {
			await mkdir(join(quiet, 'threads', 'thd_abc', 'runs', 'run_1'), { recursive: true })
			await mkdir(join(loud, 'threads', 'thd_abc', 'runs', 'run_1'), { recursive: true })

			const records: LogRecord[] = []
			const sink: LogSink = { emit: (record) => records.push(record) }

			const control = await RunContextFactory.ensureMigrated(
				loud,
				new DefaultFilesystemMigrator(loggingMigrationSink(hostLogger(sink))),
			)
			expect(control.kind).toBe('migrated')
			expect(records.length).toBeGreaterThan(0)

			records.length = 0
			const result = await RunContextFactory.ensureMigrated(quiet)

			expect(result.kind).toBe('migrated')
			expect(records).toHaveLength(0)
		} finally {
			await rm(quiet, { recursive: true, force: true })
			await rm(loud, { recursive: true, force: true })
		}
	})
})
