import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import {
	type EvidenceRecallCandidate,
	type EvidenceRecallRequest,
	createEvidenceRecallStep,
} from '../../../turn/evidence-recall.js'
import type { Message } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * The real conversation-evidence step, driven through a turn of three calls
 * while a tool result lands in the archive between the first and the second.
 * The step reads the archive on the first call only; every request after it
 * begins with the whole message list of the one before, and only appends.
 */

registerMock()

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

describe('conversation evidence across the calls of one turn', () => {
	it('is read once, and no later request rewrites the one before it', async () => {
		const ids = {
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
		}
		const earlierTurn = generateTurnId()
		const entry = (seq: number, excerpt: string): EvidenceRecallCandidate => ({
			scope: {
				tenantId: ids.tenantId,
				projectId: ids.projectId,
				sessionId: ids.sessionId,
				turnId: earlierTurn,
			},
			seq,
			part: 0,
			source: 'tool_completed',
			toolName: 'read',
			retained: 'full',
			excerpt,
			byteOffset: 0,
		})
		const archive: EvidenceRecallCandidate[] = [entry(1, 'DELTA tracking code: A17')]
		const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => ({
			candidates: [...archive],
			scannedBytes: 64,
			incomplete: false,
		}))
		const tools = testToolset({
			name: 'look',
			description: 'Look at something',
			inputSchema: z.object({ what: z.string() }),
			execute: async () => {
				// A tool result reaches the archive while the turn is running.
				archive.push(entry(2, 'DELTA tracking code: B99'))
				return { success: true, output: 'seen' }
			},
		})
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'look', args: { what: 'x' } }] },
				{ toolCalls: [{ id: 'c2', name: 'look', args: { what: 'y' } }] },
				{ text: 'done' },
			],
		})

		await drainQuery({
			toolsets: [tools],
			agentId: 'a',
			agentName: 'A',
			systemPrompt: 'You are a coding agent.',
			workingDirectory: process.cwd(),
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
			compactionConfig: CompactionConfigSchema.parse({}),
			...ids,
			provider,
			prepareStep: createEvidenceRecallStep({
				scope: {
					tenantId: ids.tenantId,
					projectId: ids.projectId,
					sessionId: ids.sessionId,
				},
				retrieve,
			}),
			messages: [{ role: 'user', content: 'what was the DELTA tracking code' }],
		})

		expect(provider.requests).toHaveLength(3)
		expect(retrieve).toHaveBeenCalledTimes(1)
		const shape = (messages: readonly Message[]) => messages.map((m) => `${m.role}:${text(m)}`)
		for (const request of provider.requests) {
			const lines = shape(request.messages as Message[])
			expect(lines.some((line) => line.includes('A17'))).toBe(true)
			expect(lines.some((line) => line.includes('B99'))).toBe(false)
		}
		for (const [i, request] of provider.requests.entries()) {
			if (i === 0) continue
			const before = shape(provider.requests[i - 1]?.messages as Message[])
			expect(shape(request.messages as Message[]).slice(0, before.length)).toEqual(before)
		}
	})
})
