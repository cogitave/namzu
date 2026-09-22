import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { readAuditTrail } from '../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { drainQuery } from '../../runtime/query/index.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import { replayAudit } from '../../types/session/audit.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { InMemorySessionLog } from '../session-log/index.js'

/**
 * Invariant test (ses_020 §5, LOG-14): for a completed turn, `replayAudit`
 * reconstructs the SAME cost and status the derived `Turn` settled
 * with — reading the audit trail alone, through the real `drainQuery`
 * orchestration rather than a hand-simulated call to `recordAudit`. A
 * divergence here is a defect in the derived summary, never in the trail.
 */

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

describe("a completed turn's audit trail replays to its own summary", () => {
	it('replayAudit(readAuditTrail()) reproduces Turn.costInfo and Turn.status', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-replay-'))
		workdirs.push(workingDirectory)

		const sessionId = '6b8c1b28-3cdf-4873-9cb3-dd0401d912c7' as SessionId
		const sessionLog = new InMemorySessionLog({ sessionId })
		const provider = new MockLLMProvider({
			turns: [
				{ text: 'done', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
			],
		})

		const result = await drainQuery(
			{
				provider,
				tools: new ToolRegistry(),
				turnConfig: {
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
				sessionId,
				topicId: 'b8388597-184a-4544-916e-1e5fb3e6bc97' as TopicId,
				projectId: 'ddfe0aea-433a-4b7c-ba63-c7301ab2a1ff' as ProjectId,
				tenantId: 'f0ed1aa3-0d7e-498a-8d91-e5197b22922d' as TenantId,
				sessionLog,
			},
			() => {},
		)

		expect(result.status).toBe('completed')

		const trail = await readAuditTrail(sessionLog)
		const summary = replayAudit(trail)

		expect(summary).toEqual({ costInfo: result.costInfo, status: 'completed' })
	})
})
