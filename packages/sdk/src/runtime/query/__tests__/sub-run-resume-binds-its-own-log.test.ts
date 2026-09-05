import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { RunDiskStore, readRunEventsIn } from '../../../store/run/disk.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { QueryParams } from '../index.js'
import { query } from '../index.js'
import { resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'

/**
 * A delegated run's evidence lives under `<parent>/children/<run>`, and
 * `resumeRun` forwarded the run id without the parent — so resuming a sub-run
 * bound `<base>/<run>` instead. That is a second, empty transcript under a run
 * id that already has one: its sequence restarts at 1, and a consumer catching
 * up on a live sub-run is told it has produced nothing at all.
 *
 * The parent is what makes the address, so the test asserts the ADDRESS: the
 * events land in the directory that already holds the run's history.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const PARENT = 'c0250b29-330b-445f-b11d-2926ffd9059c' as RunId

const SCOPE: RunStateScope = {
	tenantId: '9d281239-ff89-4ad9-8483-672c036fb2d8' as TenantId,
	projectId: '20acca90-a3e6-4f9b-a1cd-0f49541e5f13' as ProjectId,
	sessionId: '358bccfc-ab33-4c8b-b205-a0c8963f066c' as SessionId,
	runId: '4721e070-5ba2-425a-bf5a-8cc927907e9a' as RunId,
	topicId: 'd53bb72a-3aa5-4c6c-a538-693dba3b26f8' as TopicId,
	parentRunId: PARENT,
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
})

function registryWithEcho(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register({
		name: 'echo',
		description: 'echo the text back',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'hi' }),
	})
	return tools
}

describe('a resumed sub-run continues its own log', () => {
	it('appends under the parent rather than opening a second transcript', async () => {
		const baseDir = await mkdtemp(join(tmpdir(), 'namzu-subrun-'))
		dirs.push(baseDir)
		const runsDir = join(baseDir, 'runs')
		const checkpointStore = new InMemoryCheckpointStore()

		const gen = query({
			messages: [createUserMessage('go')],
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
			}),
			tools: registryWithEcho(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			agentId: 'agent_sub',
			agentName: 'Sub Agent',
			workingDirectory: baseDir,
			runId: SCOPE.runId,
			parentRunId: PARENT,
			depth: 1,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			runStore: new RunDiskStore({ baseDir: runsDir, logger: LOG }),
			checkpointStore,
			resumeHandler: async () => ({ action: 'continue' as const }),
		} as unknown as QueryParams)
		while (!(await gen.next()).done) {
			// drain
		}

		const childDir = join(runsDir, PARENT, 'children', SCOPE.runId)
		const before = (await readRunEventsIn(childDir)).length
		expect(before).toBeGreaterThan(0)

		await resumeRun({
			scope: SCOPE,
			checkpointStore,
			provider: new MockLLMProvider({ turns: [{ text: 'continued' }] }),
			tools: registryWithEcho(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				maxResponseTokens: 256,
			},
			agentId: 'agent_sub',
			agentName: 'Sub Agent',
			workingDirectory: baseDir,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			runStore: new RunDiskStore({ baseDir: runsDir, logger: LOG }),
			resumeHandler: async () => ({ action: 'continue' as const }),
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		const after = await readRunEventsIn(childDir)
		// Continued, not restarted: the numbering picks up where the log left off.
		expect(after.length).toBeGreaterThan(before)
		expect(after.map((e) => e.seq)).toEqual(after.map((_, i) => i + 1))
		// And no sibling directory was minted at the top level for a run that
		// belongs under its parent.
		expect(await readdir(runsDir)).not.toContain(SCOPE.runId)
	})
})
