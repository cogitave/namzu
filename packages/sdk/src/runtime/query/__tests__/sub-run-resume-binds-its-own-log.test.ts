import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { QueryParams } from '../index.js'
import { query } from '../index.js'
import { resumeSession } from '../resume-session.js'
import { defaultSessionPaths, resolveSessionStorage } from '../session-storage.js'
import type { TurnStateScope } from '../turn-state.js'
import { records } from './support/session.js'

/**
 * A delegated child session's log lives under its parent session
 * (`<parent-id>/<child-id>.jsonl`). Resuming a child's turn must continue
 * that log — a second log for the same session id would restart its
 * sequence at 1, and a consumer catching up on a live child would be told it
 * has produced nothing at all.
 *
 * The parent is what makes the address, so the test asserts the ADDRESS: the
 * resumed turn's records land in the log that already holds the child's
 * history, and nothing is opened at the top level of the project.
 */

const PARENT_SESSION = 'c0250b29-330b-445f-b11d-2926ffd9059c' as SessionId
const PARENT_TURN = '6b1ac1a2-9d9b-4b41-8a52-2d6f2f4c1c55' as TurnId

const SCOPE: TurnStateScope = {
	tenantId: '9d281239-ff89-4ad9-8483-672c036fb2d8' as TenantId,
	projectId: '20acca90-a3e6-4f9b-a1cd-0f49541e5f13' as ProjectId,
	sessionId: '358bccfc-ab33-4c8b-b205-a0c8963f066c' as SessionId,
	turnId: '4721e070-5ba2-425a-bf5a-8cc927907e9a' as TurnId,
	topicId: 'd53bb72a-3aa5-4c6c-a538-693dba3b26f8' as TopicId,
	parentSessionId: PARENT_SESSION,
	parentTurnId: PARENT_TURN,
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

describe('a resumed child turn continues its own log', () => {
	it('appends under the parent rather than opening a second log', async () => {
		const baseDir = await mkdtemp(join(tmpdir(), 'namzu-subrun-'))
		dirs.push(baseDir)

		// The child turn parks at its first checkpoint.
		const gen = query({
			messages: [createUserMessage('go')],
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
			}),
			tools: registryWithEcho(),
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			agentId: 'agent_sub',
			agentName: 'Sub Agent',
			workingDirectory: baseDir,
			turnId: SCOPE.turnId,
			parentSessionId: PARENT_SESSION,
			parentTurnId: PARENT_TURN,
			depth: 1,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			resumeHandler: async (request: { type: string }) =>
				request.type === 'iteration_checkpoint'
					? { action: 'pause' as const, reason: 'hold here' }
					: { action: 'continue' as const },
		} as unknown as QueryParams)
		while (!(await gen.next()).done) {
			// drain
		}

		const paths = await defaultSessionPaths(baseDir)
		const childLog = paths.sessionLog({ sessionId: SCOPE.sessionId, ancestors: [PARENT_SESSION] })
		const topLevelLog = paths.sessionLog({ sessionId: SCOPE.sessionId })
		expect(existsSync(childLog)).toBe(true)
		expect(existsSync(topLevelLog)).toBe(false)

		// What a host opens to resume the child: its storage, located through its parent.
		const storage = await resolveSessionStorage({
			sessionId: SCOPE.sessionId,
			parentSessionId: PARENT_SESSION,
			workingDirectory: baseDir,
		})
		const before = await records(storage.log)
		expect(before.length).toBeGreaterThan(0)

		const outcome = await resumeSession({
			scope: SCOPE,
			sessionLog: storage.log,
			checkpointStore: storage.checkpoints,
			pendingDecision: { action: 'continue' },
			provider: new MockLLMProvider({ turns: [{ text: 'continued' }] }),
			tools: registryWithEcho(),
			turnConfig: {
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
			parentSessionId: PARENT_SESSION,
			parentTurnId: PARENT_TURN,
			resumeHandler: async () => ({ action: 'continue' as const }),
		})
		expect(outcome.resumed).toBe(true)

		const after = await records(storage.log)
		// Continued, not restarted: the numbering picks up where the log left off.
		expect(after.length).toBeGreaterThan(before.length)
		expect(after.map((record) => record.seq)).toEqual(after.map((_, i) => i + 1))
		expect(after.slice(before.length).map((record) => record.type)).toContain('turn_resuming')
		// And no second log was opened at the top level for a session that
		// belongs under its parent.
		expect(existsSync(topLevelLog)).toBe(false)
	})
})
