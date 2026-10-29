import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A tool whose every result fills the window: the loop clears it, the model
 * calls the tool again, and so on. Each relief follows the last within the
 * refill window, so the rapid-refill check stops the turn
 * on the third. Without counting reactive reliefs, the only end was the
 * placeholders themselves filling the window, tens of paid calls later.
 */
const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

it('stops a re-read loop at the refill breaker after a handful of calls', async () => {
	let calls = 0
	let overflows = 0
	class Overflowing extends MockLLMProvider {
		override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			calls++
			const size = params.messages.reduce(
				(n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
				0,
			)
			if (size > 30_000) {
				overflows++
				throw Object.assign(new Error('prompt is too long'), { status: 400 })
			}
			yield* super.chatStream(params)
		}
	}
	const provider = new Overflowing({
		nextTurn: () => ({ toolCalls: [{ name: 'read', args: {} }] }),
		capabilities: { supportsTools: true, supportsFunctionCalling: true, supportsStreaming: true },
	})
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-refill-'))
	dirs.push(workingDirectory)
	const result = await drainQuery({
		provider,
		toolsets: [
			testToolset({
				name: 'read',
				description: 'read a big file',
				inputSchema: z.object({}),
				execute: async () => ({ success: true, output: 'r'.repeat(100_000) }),
			}),
		],
		turnConfig: {
			model: 'm',
			timeoutMs: 60_000,
			tokenBudget: 50_000_000,
			maxIterations: 400,
			maxResponseTokens: 256,
		},
		agentId: 'a',
		agentName: 'a',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
		topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
		projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
		tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
		retry: false,
		compactionConfig: {
			strategy: 'salience',
			circuitBreaker: true,
			triggerThreshold: 0.7,
			resetThreshold: 0.4,
			keepRecentMessages: 6,
			clearToolResults: true,
			recordShedHistory: false,
			keepRecentToolResults: 3,
			minToolResultCharsToClear: 1_000,
			maxToolResults: 30,
			maxListSize: 25,
			keepFirstEntries: 3,
			llmVerification: false,
			llmVerificationMaxTokens: 2048,
			richStateThreshold: 15,
			convoTextBudget: 12_000,
			maxSentencesPerTurn: 5,
			maxCharsPerNote: 500,
			maxCharsPerRequirement: 300,
			maxCharsPerTask: 400,
		},
	})

	expect(result.stopReason).toBe('error')
	expect(result.lastError).toMatch(/smaller parts/)
	expect(result.lastError).not.toMatch(/\/clear|\/new|start fresh/i)
	// Eight today; the unguarded loop took 61 and ended only when the cleared
	// placeholders filled the window.
	expect(calls).toBeLessThanOrEqual(10)
	// One initial overflow, followed by three actual refills. This also proves
	// recovery was allowed rather than stopping on the first provider rejection.
	expect(overflows).toBe(4)
})
