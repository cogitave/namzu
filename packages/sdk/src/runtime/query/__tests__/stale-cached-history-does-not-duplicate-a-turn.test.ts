import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	type AssistantMessage,
	createProjectInstructionMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A completed turn's OWN settled `Turn.messages` is not the same array a
 * fresh fold of the session log produces, and a host is explicitly invited
 * to cache and pass the former back in (`withoutRecordedPrefix`'s doc
 * comment: "a host that passes the whole conversation is tolerated").
 *
 * The two diverge by exactly the project-instruction snapshots
 * `collapseProjectInstructionSnapshots` sheds from a turn's own working set:
 * the log keeps one durable "message" record per turn that carried one, but
 * a turn that is not the session's first collapses every earlier one out of
 * its own `messages` before it ever reaches a provider. So turn 2's settled
 * `messages` is one message SHORTER than the log's own fold through the same
 * point, at the position turn 1's own snapshot used to sit.
 *
 * Before the fix, `withoutRecordedPrefix` compared that shorter array against
 * a fresh fold positionally and mismatched at message 0 (a snapshot on the
 * log's side, not on the caller's) — matching nothing, so the WHOLE stale
 * array was kept and concatenated after the correctly-folded history,
 * duplicating every message the two turns shared, including turn 2's own
 * tool call. `validateToolCallIds` (`compaction/dangling.ts`) then correctly
 * refused the rewrite it could not tell apart from a tampered log.
 *
 * This is exactly what a live `namzu` session does between two ordinary
 * sends — no checkpoint, pause, resume or process restart required, only a
 * third message following a second one that itself followed a first. Text is
 * a placeholder; nothing here describes a real conversation.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingTree(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-stale-history-'))
	dirs.push(cwd)
	await mkdir(join(cwd, 'packages', 'a'), { recursive: true })
	await writeFile(join(cwd, 'packages', 'a', 'file.ts'), 'placeholder file body\n')
	return cwd
}

function identity() {
	return {
		sessionId: 'd0e7aab2-13ba-424a-ac82-a1f85b39ff24' as SessionId,
		topicId: '78de4e8b-5b17-4b6b-b61e-d74e2b56e2cb' as TopicId,
		projectId: '7643119a-abcd-4b86-bc3f-8f5883b0fb91' as ProjectId,
		tenantId: '23a070b7-1902-49bd-9d13-5c1594228e1f' as TenantId,
	}
}

const projectInstructionContext = {
	prepareInitialSnapshot: () =>
		createProjectInstructionMessage('placeholder policy', ['AGENTS.md']),
	observeToolResult: () => undefined,
}

describe('a stale cached conversation must not duplicate a completed turn', () => {
	it('a third send does not repeat the second turns tool-call id when it reuses the second turns own settled messages', async () => {
		const cwd = await workingTree()
		const scope = identity()
		const log = new InMemorySessionLog({ sessionId: scope.sessionId })
		const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }

		// Turn 1: the session's first turn, so nothing is collapsed out of its
		// own settled messages yet.
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

		// Turn 2: a tool call, so it checkpoints mid-flight like the real
		// session this reproduces. Its OWN project-instruction snapshot
		// collapses turn 1's out of its settled `messages`.
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
			projectInstructionContext,
			...scope,
		})
		expect(run2.status).toBe('completed')
		const toolCallId = run2.messages
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.find((message) => (message.toolCalls?.length ?? 0) > 0)?.toolCalls?.[0]?.id
		expect(toolCallId).toBeDefined()

		// A genuine resume (a fresh fold of the durable log, the shape
		// `loadResumableConversation`/`readFoldedHistory` produce) already
		// worked before the fix and must keep working after it.
		const resumed = new InMemorySessionLog({
			sessionId: log.sessionId,
			medium: log.medium,
			leases: log.leaseStore,
			spills: log.spillStore,
		})
		const foldedHistory = (await readFoldedHistory(resumed)).map((entry) => entry.message)
		const runAfterResume = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply after resume' }),
			toolsets: [],
			messages: [...foldedHistory, createUserMessage('placeholder resumed message')],
			workingDirectory: cwd,
			sessionLog: resumed,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			projectInstructionContext,
			...scope,
		})
		expect(runAfterResume.status).toBe('completed')
		expect(
			runAfterResume.messages
				.filter((message): message is AssistantMessage => message.role === 'assistant')
				.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []),
		).toEqual([toolCallId])

		// This is the bug: a THIRD live send, in the SAME process, carrying
		// turn 2's own settled `messages` forward exactly as a host is told
		// it may. Before the fix this threw "repeats tool-call id".
		const run3 = await drainQuery({
			provider: new MockLLMProvider({ responseText: 'placeholder reply three' }),
			toolsets: [],
			messages: [...run2.messages, createUserMessage('placeholder third message')],
			workingDirectory: cwd,
			sessionLog: log,
			turnConfig,
			agentId: 'repro',
			agentName: 'Repro',
			projectInstructionContext,
			...scope,
		})
		expect(run3.status).toBe('completed')
		// The tool call turn 2 already recorded appears exactly once.
		const occurrences = run3.messages
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.flatMap((message) => message.toolCalls ?? [])
			.filter((call) => call.id === toolCallId)
		expect(occurrences).toHaveLength(1)
	})
})
