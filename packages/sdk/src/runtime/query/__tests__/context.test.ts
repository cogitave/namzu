import { describe, expect, it, vi } from 'vitest'
import { DefaultPathBuilder, type PathBuilder } from '../../../session/workspace/path-builder.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { AgentRunConfig } from '../../../types/run/index.js'
import type { ProjectId } from '../../../types/session/ids.js'
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
		projectId,
		tenantId,
		workingDirectory: '/tmp/run-context-test',
		...overrides,
	}
}

describe('RunContextFactory.build — Phase 6', () => {
	it('requires sessionId, projectId, tenantId and returns them on the context', () => {
		const cfg = buildConfig()
		const ctx = RunContextFactory.build(cfg)

		expect(ctx.sessionId).toBe(cfg.sessionId)
		expect(ctx.projectId).toBe(cfg.projectId)
		expect(ctx.tenantId).toBe(cfg.tenantId)
		// threadId remains as a deprecated mirror of projectId.
		expect(ctx.threadId).toBe(cfg.projectId)
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

		// No more `/.namzu/threads/{threadId}/runs` — the new layout lives under
		// projects/{pid}/sessions/{sid}.
		expect(ctx.outputDir).toContain('/.namzu/projects/prj_test/sessions/ses_test')
		expect(ctx.outputDir).not.toContain('threads')
	})

	it('seeds RunPersistence with propagated sessionId/tenantId/projectId', () => {
		const cfg = buildConfig()
		const ctx = RunContextFactory.build(cfg)

		expect(ctx.runMgr.sessionId).toBe(cfg.sessionId)
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
		expect(runDir).toBe('/base/.namzu/projects/prj_x/sessions/ses_y/runs/run_z')
	})
})
