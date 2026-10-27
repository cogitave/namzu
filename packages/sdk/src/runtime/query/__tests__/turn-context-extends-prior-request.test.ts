import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { Message } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Each request of a session should begin with the whole of the one before it,
 * so a caching provider keeps reading the same prefix across turns. What a
 * request carries for itself alone (a step-context message) is outside that
 * prefix by definition; everything ahead of the first such message must come
 * back unchanged in the next request.
 */

registerMock()

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

const isRequestOnly = (message: Message): boolean =>
	message.role === 'user' &&
	message.source?.type === 'runtime-context' &&
	message.source.kind === 'step-context'

/** The messages a caching driver can read back: those before the first request-only one. */
export function cacheable(messages: readonly Message[]): string[] {
	const end = messages.findIndex(isRequestOnly)
	return (end < 0 ? messages : messages.slice(0, end)).map((m) => `${m.role}:${text(m)}`)
}

function setup() {
	const tools = testToolset({
		name: 'look',
		description: 'Look at something',
		inputSchema: z.object({ what: z.string() }),
		execute: async () => ({ success: true, output: 'seen' }),
	})
	return {
		toolsets: [tools],
		agentId: 'a',
		agentName: 'A',
		systemPrompt: 'You are a coding agent.',
		workingDirectory: process.cwd(),
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		compactionConfig: CompactionConfigSchema.parse({}),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
}

describe('a turn after another begins with what the earlier turn sent', () => {
	// Request-only context, as steps offer it today: it sits before the
	// operator message and is gone on the next turn, so the next request
	// diverges at the first such block. Kept as a known failure until the
	// recorded form (turn-context-entries.test.ts) replaces it.
	it.fails('holds when a step offers request-only context', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'look', args: { what: 'x' } }] },
				{ text: 'first answer' },
				{ text: 'second answer' },
			],
		})
		const base = setup()
		const first = await drainQuery({
			...base,
			provider,
			prepareStep: () => ({ context: 'REPOSITORY TEXT' }),
			messages: [{ role: 'user', content: 'first question' }],
		})
		await drainQuery({
			...base,
			provider,
			prepareStep: () => ({ context: 'REPOSITORY TEXT' }),
			messages: [...first.messages, { role: 'user', content: 'second question' }],
		})

		const lastOfFirst = provider.requests[1]?.messages as Message[]
		const firstOfSecond = provider.requests[2]?.messages as Message[]
		const before = cacheable(lastOfFirst)
		expect(cacheable(firstOfSecond).slice(0, before.length)).toEqual(before)
		// And what was cacheable covers the operator message of the first turn.
		expect(before.some((line) => line.includes('first question'))).toBe(true)
	})
})
