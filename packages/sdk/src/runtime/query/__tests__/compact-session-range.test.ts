import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { MessageId, SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { compactSessionRange } from '../compact-session.js'
import { drainQuery } from '../index.js'

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
const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }
const config = CompactionConfigSchema.parse({
	strategy: 'structured',
	keepRecentMessages: 2,
	clearToolResults: false,
	llmVerification: false,
})

async function conversation(turns: number) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-compact-range-'))
	dirs.push(cwd)
	const log = new InMemorySessionLog({ sessionId: scope.sessionId })
	let history: readonly Message[] = []
	for (let turn = 1; turn <= turns; turn++) {
		const run = await drainQuery({
			provider: new MockLLMProvider({ responseText: `reply ${turn}` }),
			toolsets: [],
			messages: [...history, createUserMessage(`message ${turn}: padding so it is not tiny`)],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'range',
			agentName: 'Range',
			...scope,
		})
		history = run.messages
	}
	const users = history.filter((m) => m.role === 'user')
	return { log, history, users }
}

const text = (m: Message) => (typeof m.content === 'string' ? m.content : '')

describe('compactSessionRange', () => {
	it('summarises everything before a message and leaves it and what follows alone', async () => {
		const { log, users } = await conversation(3)
		const second = users[1]?.id as MessageId
		const result = await compactSessionRange({
			sessionId: scope.sessionId,
			locator: { log },
			provider: new MockLLMProvider({ responseText: 'unused' }),
			config,
			until: second,
		})
		expect(result?.shed).toBeGreaterThan(0)
		const folded = (await readFoldedHistory(log)).map((e) => e.message)
		expect(folded.map(text).some((t) => t.startsWith('message 1'))).toBe(false)
		expect(folded.map(text).filter((t) => t.startsWith('message 2'))).toHaveLength(1)
		expect(folded.map(text).filter((t) => t.startsWith('message 3'))).toHaveLength(1)
		expect(folded[0]?.role).toBe('system')
	})

	it('summarises a message and everything after it and leaves what came before alone', async () => {
		const { log, users } = await conversation(3)
		const second = users[1]?.id as MessageId
		const result = await compactSessionRange({
			sessionId: scope.sessionId,
			locator: { log },
			provider: new MockLLMProvider({ responseText: 'unused' }),
			config,
			from: second,
		})
		expect(result?.shed).toBeGreaterThan(0)
		const folded = (await readFoldedHistory(log)).map((e) => e.message)
		const texts = folded.map(text)
		expect(texts.filter((t) => t.startsWith('message 1'))).toHaveLength(1)
		expect(texts.some((t) => t.startsWith('message 2'))).toBe(false)
		expect(texts.some((t) => t.startsWith('message 3'))).toBe(false)
		expect(folded.at(-1)?.role).toBe('system')
	})

	it('refuses a message that is not in the current context, and appends nothing', async () => {
		const { log } = await conversation(2)
		const before = (await readFoldedHistory(log)).length
		await expect(
			compactSessionRange({
				sessionId: scope.sessionId,
				locator: { log },
				provider: new MockLLMProvider({ responseText: 'unused' }),
				config,
				until: 'msg_00000000-0000-4000-8000-000000000000' as MessageId,
			}),
		).rejects.toMatchObject({ code: 'not_found' })
		expect((await readFoldedHistory(log)).length).toBe(before)
	})

	it('returns null and appends nothing for a span with nothing to fold', async () => {
		const { log, users } = await conversation(2)
		const first = users[0]?.id as MessageId
		const before = (await readFoldedHistory(log)).length
		const result = await compactSessionRange({
			sessionId: scope.sessionId,
			locator: { log },
			provider: new MockLLMProvider({ responseText: 'unused' }),
			config,
			until: first,
		})
		expect(result).toBeNull()
		expect((await readFoldedHistory(log)).length).toBe(before)
	})
})
