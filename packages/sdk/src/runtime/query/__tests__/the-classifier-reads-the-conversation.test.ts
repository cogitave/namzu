import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { generateSessionId } from '../../../utils/id.js'
import type { AutoReviewClassifier, AutoReviewRequest } from '../auto-review/classifier.js'
import { type QueryParams, drainQuery } from '../index.js'
import { createReviewHandler } from '../review-policy.js'

/**
 * The classifier is handed the conversation by the kernel as the resume
 * handler's second argument. A wrapper between `query()` and the policy that
 * dropped it left the classifier judging every action with nothing to read.
 * This goes through a real `query()` so the wrapper is the one that ships.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const ids = {
	topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
	projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
	tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
}

describe('the classifier under a real query()', () => {
	it("is shown the person's own messages", async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-classifier-'))
		dirs.push(cwd)
		const tools = testToolset(BashTool)
		const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
		const seen: AutoReviewRequest[] = []
		const classifier: AutoReviewClassifier = {
			async review(request) {
				seen.push(request)
				return { verdict: 'allow', stage: 1, latencyMs: 0 }
			},
			denials: { consecutive: 0, total: 0 },
			reset() {},
		}
		const sessionId = generateSessionId()
		await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'git push origin main' } }],
						finishReason: 'tool_calls',
					},
					{ text: 'done' },
				],
			}),
			toolsets: [tools],
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('please push my branch to origin main')],
			workingDirectory: cwd,
			resumeHandler: createReviewHandler({ mode: 'classify', classifier, registry }),
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
			...ids,
		} as QueryParams)
		expect(seen).toHaveLength(1)
		const users = (seen[0]?.transcript ?? [])
			.filter((m: Message) => m.role === 'user')
			.map((m: Message) => m.content)
		expect(users).toContain('please push my branch to origin main')
	})
})
