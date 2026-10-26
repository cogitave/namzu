import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { compactSession } from '../compact-session.js'
import { drainQuery } from '../index.js'

/** A host that compacts an unused conversation says so on the record. */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const scope = {
	sessionId: '3b6e9a2d-8c47-4a4e-9c88-3fbe5d5a9b01' as SessionId,
	topicId: '7c2d9e4a-1f6b-4c8d-9d2e-6b8a4c2f9e02' as TopicId,
	projectId: '5a1c8b3e-9d4f-4e6a-8c2b-1d9e6f3a5b03' as ProjectId,
	tenantId: '2d8e5c1a-6b9f-4a3d-9e1c-8f4a2b6d5c04' as TenantId,
}

async function conversation(log: InMemorySessionLog): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-idle-compaction-'))
	dirs.push(cwd)
	let history: readonly Message[] = []
	for (let turn = 1; turn <= 3; turn++) {
		const run = await drainQuery({
			provider: new MockLLMProvider({ responseText: `reply ${turn}` }),
			toolsets: [],
			messages: [...history, createUserMessage(`message ${turn}: padding so it is not tiny`)],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 4,
			},
			agentId: 'a',
			agentName: 'A',
			...scope,
		})
		history = run.messages
	}
}

async function compactionTrigger(trigger?: 'idle' | 'manual'): Promise<string | undefined> {
	const log = new InMemorySessionLog({ sessionId: scope.sessionId })
	await conversation(log)
	await compactSession({
		sessionId: scope.sessionId,
		locator: { log },
		...(trigger ? { trigger } : {}),
		provider: new MockLLMProvider({ responseText: 'unused' }),
		config: CompactionConfigSchema.parse({
			strategy: 'structured',
			keepRecentMessages: 2,
			clearToolResults: false,
			llmVerification: false,
		}),
	})
	const { entries } = await log.readAll()
	for (const { record } of entries) {
		if (record.type === 'compaction') return record.trigger
	}
	return undefined
}

describe('compactSession trigger', () => {
	it('records an idle compaction as idle', async () => {
		expect(await compactionTrigger('idle')).toBe('idle')
	})
	it('still records a plain request as manual', async () => {
		expect(await compactionTrigger()).toBe('manual')
	})
})
