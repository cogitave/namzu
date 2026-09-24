import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { compactSession } from '../compact-session.js'
import { drainQuery } from '../index.js'

/**
 * `readEverRecordedMessages` (`manager/session/turn-recorder.ts`) reads
 * EVERY `message`/`message_replaced` record the log ever wrote, not just the
 * CURRENT fold — so a message a compaction has since summarized away is
 * still known by its id, even though `readFoldedHistory` no longer surfaces
 * it as itself.
 *
 * A host that cached history from before that compaction and replays the
 * exact same message (same id, same content) must see it silently dropped
 * — the fold's own summary already speaks for it — never a
 * `stale_cached_history` conflict and never a second, raw copy of text the
 * summary also paraphrases.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-precompaction-replay-'))
	dirs.push(dir)
	return dir
}

function identity() {
	return {
		sessionId: '3b6e9a2d-8c47-4a4e-9c88-3fbe5d5a9b01' as SessionId,
		topicId: '7c2d9e4a-1f6b-4c8d-9d2e-6b8a4c2f9e02' as TopicId,
		projectId: '5a1c8b3e-9d4f-4e6a-8c2b-1d9e6f3a5b03' as ProjectId,
		tenantId: '2d8e5c1a-6b9f-4a3d-9e1c-8f4a2b6d5c04' as TenantId,
	}
}

const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }

describe('a message from before a compaction, replayed by the host', () => {
	it('is dropped without error, and the raw text is not duplicated alongside its summary', async () => {
		const cwd = await workingDirectory()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })

		let history: readonly Message[] = []
		for (let turn = 1; turn <= 3; turn++) {
			const run = await drainQuery({
				provider: new MockLLMProvider({ responseText: `placeholder reply ${turn}` }),
				tools: new ToolRegistry(),
				messages: [
					...history,
					createUserMessage(`placeholder message ${turn}: padding so it is not trivially tiny`),
				],
				workingDirectory: cwd,
				sessionLog: log,
				turnConfig,
				agentId: 'repro',
				agentName: 'Repro',
				...scope,
			})
			expect(run.status).toBe('completed')
			history = run.messages
		}
		const firstUser = history.find((message) => message.role === 'user')
		if (!firstUser) throw new Error('fixture requires a first user message')
		expect(firstUser.id).toBeDefined()

		// A host-triggered compaction between turns, keeping only the two most
		// recent messages — turn 1's exchange is old enough to be shed.
		const compacted = await compactSession({
			sessionId: scope.sessionId,
			locator: { log },
			provider: new MockLLMProvider({ responseText: 'unused' }),
			config: CompactionConfigSchema.parse({
				strategy: 'structured',
				keepRecentMessages: 2,
				clearToolResults: false,
				llmVerification: false,
			}),
		})
		expect(compacted?.shed).toBeGreaterThan(0)

		// The host's own cache still holds turn 1's original message, from
		// before the compaction ran — unedited, same id.
		const provider4 = new MockLLMProvider({ responseText: 'placeholder reply 4' })
		const run4 = await drainQuery({
			provider: provider4,
			tools: new ToolRegistry(),
			messages: [firstUser, ...history.slice(1), createUserMessage('placeholder message 4')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run4.status).toBe('completed')
		const sent = provider4.requests[0]?.messages ?? []
		const rawOccurrences = sent.filter(
			(message) =>
				typeof message.content === 'string' && message.content.startsWith('placeholder message 1:'),
		)
		expect(rawOccurrences).toHaveLength(0)
	})
})
