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
	createProjectInstructionMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * `namzu exec --json` without `--session` is documented (`docs/cli/
 * exec-json.md`) as stateless: the host reconstructs `Message[]` itself
 * from the NDJSON event stream and resends it on stdin next time. Nothing
 * on that stream today surfaces `BaseMessage.id` (a stream `text_delta`
 * carries a DIFFERENT, unrelated streaming-correlation `messageId` —
 * `stream-turn.ts` mints it fresh per request and never reuses it as the
 * durable record's id), so every such host sends every message with no id,
 * on every turn, by construction.
 *
 * This is exactly `stale-cached-history-does-not-duplicate-a-turn.test.ts`'s
 * three-send scenario (turn 2's own settled `Turn.messages` is one message
 * shorter than the log's fold, because `collapseProjectInstructionSnapshots`
 * sheds an earlier turn's own project-instruction snapshot from a turn's own
 * working set while the log keeps one durable record per turn that carried
 * one) — but with `.id` stripped from every cached message before each
 * resend, reproducing the caller `prior-messages.ts`'s stdin contract
 * actually admits. A cursor that cannot re-anchor after that shed message
 * duplicates turn 2's own tool call on the third send; anchoring the
 * caller's no-id cache to the END of the log's fold (`largestSuffixAlignment`
 * in `prepare-turn.ts`) does not.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingTree(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-stateless-noid-'))
	dirs.push(cwd)
	await mkdir(join(cwd, 'packages', 'a'), { recursive: true })
	await writeFile(join(cwd, 'packages', 'a', 'file.ts'), 'placeholder file body\n')
	return cwd
}

function identity() {
	return {
		sessionId: '7b3e9c1d-4a6f-4e8c-9d2b-1f6a3c9e7b81' as SessionId,
		topicId: '9d2f6a4c-1e9b-4d3f-8c6a-5b9e2d4f7c92' as TopicId,
		projectId: '3f8c6a2e-9b1d-4c7f-8e3a-2d9b6f4c8e03' as ProjectId,
		tenantId: '6a2e9c4f-1d8b-4e6a-9c3f-8b2d6e4f9a14' as TenantId,
	}
}

const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }
const projectInstructionContext = {
	prepareInitialSnapshot: () =>
		createProjectInstructionMessage('placeholder policy', ['AGENTS.md']),
	observeToolResult: () => undefined,
}

function withoutId(message: Message): Message {
	const { id: _id, ...rest } = message
	return rest as Message
}

describe('a stateless exec --json style caller that never carries an id', () => {
	it('does not repeat a tool call, and does not lose new input, across a three-turn conversation', async () => {
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
			projectInstructionContext,
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
			// A stateless host's cache is never the SAME objects the kernel
			// handed back with ids; it is whatever it rebuilt from the
			// stream. Stripping `.id` here is the whole point of the probe.
			messages: [...run1.messages.map(withoutId), createUserMessage('placeholder second message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			projectInstructionContext,
			...scope,
		})
		expect(run2.status).toBe('completed')
		expect(run2.messages.every((message) => message.id === undefined)).toBe(false) // the kernel still stamps its OWN copy
		const toolCallId = run2.messages
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? [])[0]
		expect(toolCallId).toBeDefined()

		const run3 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply three' }),
			toolsets: [],
			messages: [...run2.messages.map(withoutId), createUserMessage('placeholder third message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			projectInstructionContext,
			...scope,
		})

		expect(run3.status).toBe('completed')
		const occurrences = run3.messages
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.flatMap((message) => message.toolCalls ?? [])
			.filter((call) => call.id === toolCallId)
		expect(occurrences).toHaveLength(1)
		// The third message itself must have reached the provider, not been
		// mistaken for an already-durable fold member.
		expect(
			run3.messages.some(
				(message) => message.role === 'user' && message.content === 'placeholder third message',
			),
		).toBe(true)
	})
})
