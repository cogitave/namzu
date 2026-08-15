import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { drainQuery } from '../../runtime/query/index.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import { replayRun } from '../../types/run/audit.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { InMemoryRunStore } from '../run/memory.js'

/**
 * Invariant test (ses_020 §5, LOG-14): for a completed run, `replayRun`
 * reconstructs the SAME cost and status the derived `Run` record settled
 * with — reading the audit trail alone, through the real `drainQuery`
 * orchestration rather than a hand-simulated call to `recordAudit`. A
 * divergence here is a defect in the derived summary, never in the trail.
 */

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

describe("a completed run's audit trail replays to its own summary", () => {
	it('replayRun(readAuditEvents()) reproduces Run.costInfo and Run.status', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-replay-'))
		workdirs.push(workingDirectory)

		const runStore = new InMemoryRunStore()
		const provider = new MockLLMProvider({
			turns: [
				{ text: 'done', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
			],
		})

		const result = await drainQuery(
			{
				provider,
				tools: new ToolRegistry(),
				runConfig: {
					model: 'mock-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 4,
					maxResponseTokens: 256,
				},
				agentId: 'agent_replay',
				agentName: 'Replay Agent',
				messages: [createUserMessage('hello')],
				workingDirectory,
				sessionId: 'ses_replay' as SessionId,
				topicId: 'top_replay' as TopicId,
				projectId: 'prj_replay' as ProjectId,
				tenantId: 'tnt_replay' as TenantId,
				runStore,
			},
			() => {},
		)

		expect(result.status).toBe('completed')

		const trail = await runStore.readAuditEvents()
		const summary = replayRun(trail)

		expect(summary).toEqual({ costInfo: result.costInfo, status: 'completed' })
	})
})
