import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENAI, NAMZU } from '../../../constants/telemetry/index.js'
import { DefaultPathBuilder, type PathBuilder } from '../../../session/workspace/path-builder.js'
import { posix } from '../../../test-support/paths.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { AgentRunConfig } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
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
	const threadId = 'thd_test' as ThreadId
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
		threadId,
		projectId,
		tenantId,
		workingDirectory: '/tmp/run-context-test',
		...overrides,
	}
}

describe('RunContextFactory.build', () => {
	it('requires sessionId, threadId, projectId, tenantId and returns them on the context', () => {
		const cfg = buildConfig()
		const ctx = RunContextFactory.build(cfg)

		expect(ctx.sessionId).toBe(cfg.sessionId)
		expect(ctx.threadId).toBe(cfg.threadId)
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

	it('seeds RunPersistence with propagated sessionId/threadId/tenantId/projectId', () => {
		const cfg = buildConfig()
		const ctx = RunContextFactory.build(cfg)

		expect(ctx.runMgr.sessionId).toBe(cfg.sessionId)
		expect(ctx.runMgr.threadId).toBe(cfg.threadId)
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

	it('binds namzu.run.id and the rest of the run scope onto the process root by default', () => {
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		const cfg = buildConfig()
		const runId = 'run_built' as RunId
		const log = RunContextFactory.buildLogger({
			agentName: cfg.agentName,
			runConfig: cfg.runConfig,
			runId,
			sessionId: cfg.sessionId,
			threadId: cfg.threadId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		})
		log.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.attributes[NAMZU.RUN_ID]).toBe(runId)
		expect(records[0]?.attributes[GENAI.AGENT_NAME]).toBe(cfg.agentName)
		expect(records[0]?.attributes[NAMZU.SESSION_ID]).toBe(cfg.sessionId)
		expect(records[0]?.attributes[NAMZU.THREAD_ID]).toBe(cfg.threadId)
		expect(records[0]?.attributes[NAMZU.PROJECT_ID]).toBe(cfg.projectId)
		expect(records[0]?.attributes[NAMZU.TENANT_ID]).toBe(cfg.tenantId)
		// The load-bearing regression test for the fromSink scope bug
		// (utils/logger.ts): before that fix, EVERY getRootLogger()-derived
		// child reported scope.name 'namzu' regardless of what buildLogger
		// bound via SCOPE_ATTRIBUTE. This installs a REAL process sink (see
		// above) and reads the record's scope, not a mock.
		expect(records[0]?.scope.name).toBe('runtime/query')
	})

	it('derives from a host-supplied runConfig.logger instead of the process root, when one is given', () => {
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
			threadId: cfg.threadId,
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
			threadId: cfg.threadId,
			projectId: cfg.projectId,
			tenantId: cfg.tenantId,
		})

		const ctx = RunContextFactory.build(buildConfig({ runId, log: preBuilt }))

		expect(ctx.log).toBe(preBuilt)
	})

	it('falls back to buildLogger — same correlated shape as the direct call — when config.log is absent', () => {
		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		const runId = 'run_auto' as RunId
		const ctx = RunContextFactory.build(buildConfig({ runId }))
		ctx.log.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.attributes[NAMZU.RUN_ID]).toBe(runId)
	})
})

describe('RunContextFactory.ensureMigrated', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it('defaults to NOOP_FILESYSTEM_MIGRATION_SINK: migrating a legacy layout reaches no installed log sink', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-ensure-migrated-'))
		try {
			await mkdir(join(root, 'threads', 'thd_abc', 'runs', 'run_1'), { recursive: true })

			const records: LogRecord[] = []
			const sink: LogSink = { emit: (record) => records.push(record) }
			installProcessSink(sink, 'debug', { replace: true })

			const result = await RunContextFactory.ensureMigrated(root)

			expect(result.kind).toBe('migrated')
			expect(records).toHaveLength(0)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
