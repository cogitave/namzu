import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { compactNow } from '../../../compaction/manual.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	createAssistantMessage,
	createProjectInstructionMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const POLICY = 'Always answer in haiku. Never edit the lockfile.'

describe('project instructions after a compaction', () => {
	it('the next turn sends the policy to the model exactly once', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-after-compaction-'))
		dirs.push(cwd)
		const snapshot = () => createProjectInstructionMessage(POLICY, ['AGENTS.md'])

		const compacted = await compactNow({
			provider: new MockLLMProvider(),
			config: CompactionConfigSchema.parse({
				strategy: 'structured',
				llmVerification: false,
				keepRecentMessages: 2,
				clearToolResults: false,
			}),
			messages: [
				snapshot(),
				createUserMessage('Refactor the loader'),
				createAssistantMessage('Reading the loader now.'),
				createUserMessage('Now write the cache'),
				createAssistantMessage('The cache is written.'),
				createUserMessage('What is next?'),
				createAssistantMessage('Fix the empty path case.'),
			],
		})
		expect(compacted).toBeDefined()

		const provider = new MockLLMProvider({ responseText: 'ok' })
		await drainQuery({
			provider,
			toolsets: [],
			messages: [...(compacted?.messages ?? []), createUserMessage('Continue')],
			workingDirectory: cwd,
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 1 },
			agentId: 'after-compaction',
			agentName: 'After compaction',
			projectInstructionContext: {
				prepareInitialSnapshot: () => snapshot(),
				observeToolResult: () => undefined,
			},
			sessionId: 'd0e7aab2-13ba-424a-ac82-a1f85b39ff24' as SessionId,
			topicId: '78de4e8b-5b17-4b6b-b61e-d74e2b56e2cb' as TopicId,
			projectId: '7643119a-abcd-4b86-bc3f-8f5883b0fb91' as ProjectId,
			tenantId: '23a070b7-1902-49bd-9d13-5c1594228e1f' as TenantId,
		})

		expect(provider.requests).toHaveLength(1)
		const sent = JSON.stringify(provider.requests[0])
		expect(sent.split(POLICY)).toHaveLength(2)
	})
})
