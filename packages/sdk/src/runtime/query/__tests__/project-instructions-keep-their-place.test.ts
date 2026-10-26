import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createProjectInstructionMessage, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The project instructions are the largest block a conversation carries, and
 * the provider can reuse its cache only up to the first message that differs
 * from the last request. A copy that moves to the front of every new turn makes
 * that first difference the instructions themselves, so nothing after them is
 * reused. They stay where they first landed; only a change is sent again.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const sessionId = 'd0e7aab2-13ba-424a-ac82-a1f85b39ff24' as SessionId
const scope = {
	sessionId,
	topicId: '78de4e8b-5b17-4b6b-b61e-d74e2b56e2cb' as TopicId,
	projectId: '7643119a-abcd-4b86-bc3f-8f5883b0fb91' as ProjectId,
	tenantId: '23a070b7-1902-49bd-9d13-5c1594228e1f' as TenantId,
}

const text = (message: { content?: unknown } | undefined): string =>
	typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content)

async function conversation(policies: readonly string[]) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-instructions-place-'))
	dirs.push(cwd)
	const sessionLog = new InMemorySessionLog({ sessionId })
	const provider = new MockLLMProvider({ responseText: 'ok' })
	for (const [turn, policy] of policies.entries()) {
		await drainQuery({
			provider,
			toolsets: [],
			messages: [createUserMessage(`question ${turn + 1}`)],
			workingDirectory: cwd,
			sessionLog,
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 1 },
			agentId: 'instructions-place',
			agentName: 'Instructions place',
			projectInstructionContext: {
				prepareInitialSnapshot: () => createProjectInstructionMessage(policy, ['AGENTS.md']),
				observeToolResult: () => undefined,
			},
			...scope,
		})
	}
	return provider.requests.map((request) => request.messages)
}

describe('project instructions keep their place in a conversation', () => {
	it('leaves an unchanged copy where it landed, so each request extends the last', async () => {
		const [first, second, third] = await conversation(['POLICY-A', 'POLICY-A', 'POLICY-A'])
		const at = (messages: typeof first) => messages?.findIndex((m) => text(m).includes('POLICY-A'))
		expect(at(first)).toBeGreaterThanOrEqual(0)
		expect(at(second)).toBe(at(first))
		expect(at(third)).toBe(at(first))
		// Everything the first request sent is the start of the second, unchanged.
		const shared = (first ?? []).filter((m) => m.role !== 'system').map(text)
		expect(
			(second ?? [])
				.filter((m) => m.role !== 'system')
				.map(text)
				.slice(0, shared.length),
		).toEqual(shared)
		// And the policy is in the request once.
		expect(JSON.stringify(third).split('POLICY-A')).toHaveLength(2)
	})

	it('keeps the first copy in place and sends a change as a complete update before the new question', async () => {
		const [first, second] = await conversation(['POLICY-A', 'POLICY-B'])
		const a = (first ?? []).findIndex((m) => text(m).includes('POLICY-A'))
		const messages = second ?? []
		// The first copy did not move, so the request still starts with the last one.
		expect(messages.findIndex((m) => text(m).includes('POLICY-A'))).toBe(a)
		const at = messages.findIndex((m) => text(m).includes('POLICY-B'))
		expect(at).toBeGreaterThan(a)
		expect(text(messages[at])).toContain('replace the project instructions given earlier')
		expect(text(messages[at + 1])).toContain('question 2')
		const shared = (first ?? []).filter((m) => m.role !== 'system').map(text)
		expect(
			messages
				.filter((m) => m.role !== 'system')
				.map(text)
				.slice(0, shared.length),
		).toEqual(shared)
	})

	it('holds only the first copy and the latest update across several changes', async () => {
		const [, , third] = await conversation(['POLICY-A', 'POLICY-B', 'POLICY-C'])
		const json = JSON.stringify(third)
		expect(json).toContain('POLICY-A')
		expect(json).not.toContain('POLICY-B')
		expect(json).toContain('POLICY-C')
	})

	it('answers a return to the first wording with a complete update, never the dropped one', async () => {
		const [, , third] = await conversation(['POLICY-A', 'POLICY-B', 'POLICY-A'])
		const json = JSON.stringify(third)
		expect(json).not.toContain('POLICY-B')
		expect(json.split('replace the project instructions given earlier')).toHaveLength(2)
	})
})
