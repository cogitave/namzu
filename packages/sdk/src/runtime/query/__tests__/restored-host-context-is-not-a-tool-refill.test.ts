import { expect, it } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createUserMessage, isTurnContextEntry } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'
import { isReminderMessage } from '../reminders.js'
import { memorySession } from './support/session.js'

/** Native TUI reproduction: a protected floor remains high, and each pass sheds
 * host context that the next request must restore. Tiny reads do not refill it.
 */
it('finishes small reads while compaction sheds and restores host context', async () => {
	const events: SessionEvent[] = []
	let reads = 0
	let passesWithReminders = 0
	let passesWithRecordedContext = 0
	const provider = new MockLLMProvider({
		turns: [
			...Array.from({ length: 6 }, (_, i) => ({
				toolCalls: [{ id: `read-${i}`, name: 'read', args: {} }],
			})),
			{ text: 'SIX_SMALL_READS_COMPLETED' },
		],
	})
	const result = await drainQuery(
		{
			...memorySession(),
			provider,
			agentId: 'a',
			agentName: 'A',
			workingDirectory: process.cwd(),
			systemPrompt: 'Standing context. '.repeat(700),
			messages: [createUserMessage('Follow the read-only file chain.')],
			toolsets: [
				testToolset({
					name: 'read',
					description: 'Read one small file',
					inputSchema: z.object({}),
					execute: async () => ({ success: true, output: `next file ${++reads}` }),
				}),
			],
			turnConfig: { model: 'mock', maxIterations: 12, tokenBudget: 0, timeoutMs: 0 },
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'structured',
				circuitBreaker: true,
				contextWindowTokens: 2_000,
				triggerThreshold: 0.7,
				llmVerification: false,
			}),
			// A valid reducer sheds host additions without losing tool-call pairs.
			contextReducer: ({ messages }) => {
				if (messages.some(isReminderMessage)) passesWithReminders++
				if (messages.some(isTurnContextEntry)) passesWithRecordedContext++
				return messages.filter(
					(message) => !isReminderMessage(message) && !isTurnContextEntry(message),
				)
			},
			reminders: () => ['Host reminder. '.repeat(1_000)],
			prepareStep: () => ({
				recordedContext: [{ key: 'repository', text: 'Repository state. '.repeat(500) }],
			}),
			retry: false,
		},
		(event) => {
			events.push(event)
		},
	)
	expect(result.stopReason).toBe('end_turn')
	expect(reads).toBe(6)
	expect(result.lastError).toBeUndefined()
	expect(
		events.filter((event) => event.type === 'compaction_completed').length,
	).toBeGreaterThanOrEqual(6)
	expect(
		events.some((event) => event.type === 'compaction_failed' && event.cause === 'refilling'),
	).toBe(false)
	expect(provider.requests.some((request) => request.messages.some(isTurnContextEntry))).toBe(true)
	expect(passesWithReminders).toBeGreaterThanOrEqual(6)
	expect(passesWithRecordedContext).toBeGreaterThanOrEqual(5)
})
