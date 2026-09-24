import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type AssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Two ways a caller's cached array can disagree with the session's own log,
 * neither of which the old, positional `withoutRecordedPrefix` could tell
 * apart from an ordinary continuation:
 *
 *  - a message the log recorded under an id, resent with EDITED content
 *    (`'edited'`) — a host must never mutate a message read from history
 *    before sending it back;
 *  - a message carrying an id THIS log never recorded (`'foreign'`) — a
 *    host must never mint its own id, only replay one the kernel gave it,
 *    for instance one copied from a different session's history.
 *
 * Both must fail closed with a named `stale_cached_history` error, not a
 * duplicated tool call, a dropped message, or a rewritten log.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingTree(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-stale-history-conflict-'))
	dirs.push(cwd)
	await mkdir(join(cwd, 'packages', 'a'), { recursive: true })
	await writeFile(join(cwd, 'packages', 'a', 'file.ts'), 'placeholder file body\n')
	return cwd
}

function identity() {
	return {
		sessionId: 'f13a5cf0-9f6b-4c8d-9df1-3b9f6b8a2f10' as SessionId,
		topicId: 'e35b1a02-6d94-4f7a-9d3e-6a6f2e8b5a11' as TopicId,
		projectId: 'a3c9d2e1-4b7f-4a9c-8e2d-1f5a9c3b7d22' as ProjectId,
		tenantId: '9d4e2a1b-7c6f-4e8d-b3a1-2c5d9e8f4a33' as TenantId,
	}
}

const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }

describe('a cached message diverging from the log', () => {
	it('refuses an edited earlier message by name, without duplicating or dropping anything', async () => {
		const cwd = await workingTree()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })

		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply one' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('placeholder first message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run1.status).toBe('completed')

		const tools2 = new ToolRegistry()
		tools2.register(ReadFileTool)
		const run2 = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ name: 'read', args: { path: 'packages/a/file.ts' } }] },
					{ text: 'placeholder reply two' },
				],
			}),
			tools: tools2,
			messages: [...run1.messages, createUserMessage('placeholder second message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run2.status).toBe('completed')

		// A host must never mutate a message read from history before sending
		// it back. This is exactly that: the FIRST turn's own user message,
		// still carrying the id the log gave it, resent with different text.
		const editedIndex = run2.messages.findIndex(
			(message) => message.role === 'user' && message.content === 'placeholder first message',
		)
		expect(editedIndex).toBeGreaterThanOrEqual(0)
		const editedId = run2.messages[editedIndex]?.id
		expect(editedId).toBeDefined()
		const cached = run2.messages.map((message, index) =>
			index === editedIndex ? { ...message, content: 'EDITED first message text' } : message,
		)

		const refusal = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply three' }),
			tools: new ToolRegistry(),
			messages: [...cached, createUserMessage('placeholder third message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		}).catch((error: unknown) => error)

		expect(refusal).toMatchObject({
			code: 'stale_cached_history',
			details: { messageId: editedId, kind: 'edited' },
		})
	})

	it('refuses a message carrying an id this log never recorded', async () => {
		const cwd = await workingTree()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })

		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply one' }),
			tools: new ToolRegistry(),
			messages: [createUserMessage('placeholder first message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run1.status).toBe('completed')

		// A foreign id: never minted by this session's own recorder — for
		// instance, copied over from a different session's history.
		const foreignId = '00000000-0000-4000-8000-000000000000' as AssistantMessage['id']
		const foreign = { ...createUserMessage('a message from somewhere else'), id: foreignId }

		const refusal = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply two' }),
			tools: new ToolRegistry(),
			messages: [...run1.messages, foreign, createUserMessage('placeholder second message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		}).catch((error: unknown) => error)

		expect(refusal).toMatchObject({
			code: 'stale_cached_history',
			details: { messageId: foreignId, kind: 'foreign' },
		})
	})
})
