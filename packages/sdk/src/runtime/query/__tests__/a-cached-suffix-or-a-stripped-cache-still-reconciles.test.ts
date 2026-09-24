import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	type AssistantMessage,
	type Message,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingTree(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-suffix-or-stripped-'))
	dirs.push(cwd)
	await mkdir(join(cwd, 'packages', 'a'), { recursive: true })
	await writeFile(join(cwd, 'packages', 'a', 'file.ts'), 'placeholder file body\n')
	return cwd
}

function identity() {
	return {
		sessionId: '6a4c8e2d-1b9f-4d3a-8e6c-2f5a9b3d7c15' as SessionId,
		topicId: '9e2b5c8a-4d1f-4c6b-9a3e-8d2f6b4c1e26' as TopicId,
		projectId: '4c8e2a6d-9b1f-4e3c-8d6a-2f9b5c3e8a37' as ProjectId,
		tenantId: '8d2f6a4c-1e9b-4d3f-8c6a-5b9e2d4f7c48' as TenantId,
	}
}

const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }

function toolCallIds(messages: readonly Message[]): (string | undefined)[] {
	return messages
		.filter((message): message is AssistantMessage => message.role === 'assistant')
		.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? [])
}

describe('a caller that does not resend the whole conversation verbatim', () => {
	it('reconciles a cached suffix (only the recent turns) without the messages it omits', async () => {
		const cwd = await workingTree()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })

		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply one' }),
			toolsets: [],
			messages: [createUserMessage('placeholder first message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run1.status).toBe('completed')

		const tools2 = testToolset(ReadFileTool)
		const run2 = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ name: 'read', args: { path: 'packages/a/file.ts' } }] },
					{ text: 'placeholder reply two' },
				],
			}),
			toolsets: [tools2],
			messages: [...run1.messages, createUserMessage('placeholder second message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run2.status).toBe('completed')
		const call2Id = toolCallIds(run2.messages)[0]
		expect(call2Id).toBeDefined()

		// A host keeping only a bounded window of "recent" turns: everything up
		// to and including the first turn's own exchange is dropped from the
		// CACHE (not from the log — the log still has it), kept ids and all.
		const firstRealIndex = run2.messages.findIndex((message) => message.role !== 'system')
		const suffix = run2.messages.slice(firstRealIndex + 1)
		expect(suffix.length).toBeLessThan(run2.messages.length)

		const run3 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply three' }),
			toolsets: [],
			messages: [...suffix, createUserMessage('placeholder third message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run3.status).toBe('completed')
		const ids = toolCallIds(run3.messages)
		expect(ids.filter((id) => id === call2Id)).toHaveLength(1)
	})

	it('reconciles by value, without duplication, when every cached message has had its id stripped', async () => {
		// A caller whose own serialization boundary drops fields it does not
		// know about (an older integration, or a round trip through a schema
		// that predates `BaseMessage.id`) resends its full cached history with
		// no `.id` on any message. This must still reconcile by value against
		// the WHOLE fold, exactly as it did before per-message ids existed —
		// not treat the whole cached array as new, unrecorded input.
		const cwd = await workingTree()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })

		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply one' }),
			toolsets: [],
			messages: [createUserMessage('placeholder first message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})
		expect(run1.status).toBe('completed')

		const stripped = run1.messages.map(({ id: _id, ...rest }) => rest as Message)
		expect(stripped.every((message) => message.id === undefined)).toBe(true)

		const provider2 = new MockLLMProvider({ responseText: 'placeholder reply two' })
		const run2 = await drainQuery({
			provider: provider2,
			toolsets: [],
			messages: [...stripped, createUserMessage('placeholder second message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			...scope,
		})

		expect(run2.status).toBe('completed')
		const sent = provider2.requests[0]?.messages ?? []
		const firstMessageOccurrences = sent.filter(
			(message) =>
				typeof message.content === 'string' && message.content === 'placeholder first message',
		)
		expect(firstMessageOccurrences).toHaveLength(1)
	})

	it('still reaches the provider with a genuinely new, never-recorded no-id message under continuationMode', async () => {
		// `continuationMode` is the documented lever for a host that wants its
		// cached array carried forward exactly as given (no per-turn system
		// floor rebuild): outside it, an arbitrary historical system message
		// is deliberately rebuilt fresh every turn (`projectStateBearingHistory`
		// in this same file), independent of id-based reconciliation. Under
		// it, a new no-id message this log never recorded is neither a
		// `stale_cached_history` conflict nor dropped as an already-durable
		// fold member: it reaches the provider once.
		const cwd = await workingTree()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })

		const run1 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply one' }),
			toolsets: [],
			messages: [createUserMessage('placeholder first message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			continuationMode: true,
			...scope,
		})
		expect(run1.status).toBe('completed')

		const novelText = 'NOVEL HOST SYSTEM NOTE never recorded before, must reach the provider'
		const provider2 = new MockLLMProvider({ responseText: 'placeholder reply two' })
		const run2 = await drainQuery({
			provider: provider2,
			toolsets: [],
			messages: [
				...run1.messages,
				createSystemMessage(novelText),
				createUserMessage('placeholder second message'),
			],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			continuationMode: true,
			...scope,
		})

		expect(run2.status).toBe('completed')
		const sent = provider2.requests[0]?.messages ?? []
		const novelOccurrences = sent.filter(
			(message) => typeof message.content === 'string' && message.content === novelText,
		)
		expect(novelOccurrences).toHaveLength(1)
	})
})
