import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import type { ContextReducer } from '../../../compaction/reducer.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A context overflow is recovered from on its own, in
 * more than one step: a first compaction, then a deeper one when the retry is
 * still too long. These tests use a provider that rejects every request above
 * a size until the history is small enough, and watch how far Namzu gets.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function sizeOf(params: ChatCompletionParams): number {
	return params.messages.reduce(
		(n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
		0,
	)
}

/** Rejects with `wording` until the request is no larger than `limitChars`. */
class OverflowingProvider extends MockLLMProvider {
	seen: number[] = []
	constructor(
		private readonly limitChars: number,
		private readonly wording = 'prompt is too long: context_length_exceeded',
	) {
		super({ turns: [{ text: 'answered after relief' }] })
	}

	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const size = sizeOf(params)
		this.seen.push(size)
		if (size > this.limitChars) {
			throw Object.assign(new Error(this.wording), { status: 400 })
		}
		yield* super.chatStream(params)
	}
}

const COMPACTION = {
	strategy: 'structured' as const,
	triggerThreshold: 0.7,
	resetThreshold: 0.4,
	keepRecentMessages: 6,
	clearToolResults: true,
	recordShedHistory: true,
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
}

async function run(
	provider: MockLLMProvider,
	messages: Message[],
	compaction: Record<string, unknown> = {},
	contextReducer?: ContextReducer,
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-ladder-'))
	dirs.push(workingDirectory)
	return drainQuery({
		provider,
		toolsets: [],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 20_000,
			tokenBudget: 5_000_000,
			maxIterations: 8,
			maxResponseTokens: 256,
		},
		agentId: 'agent_o',
		agentName: 'Overflow',
		messages,
		workingDirectory,
		sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
		topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
		projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
		tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
		retry: false,
		compactionConfig: { ...COMPACTION, ...compaction },
		...(contextReducer ? { contextReducer } : {}),
	})
}

/** user / assistant exchanges of `chars` each, ending on a user message. */
function exchanges(count: number, chars: number): Message[] {
	const out: Message[] = []
	for (let i = 0; i < count; i++) {
		out.push(createUserMessage(`question ${i}: ${'q'.repeat(chars)}`))
		out.push(createAssistantMessage(`answer ${i}: ${'a'.repeat(chars)}`))
	}
	out.push(createUserMessage(`final question: ${'f'.repeat(chars)}`))
	return out
}

describe('the overflow ladder', () => {
	it('(a) compacts a second, deeper time when the first relief is not enough', async () => {
		// Six verbatim messages of 3 000 chars cannot fit a 15 000 char window; the
		// newest round alone can.
		const provider = new OverflowingProvider(15_000)
		const result = await run(provider, exchanges(10, 3_000))

		// The overflow, the first relief (still too big), the deeper pass (fits).
		expect(provider.seen).toHaveLength(3)
		expect(provider.seen[1]).toBeGreaterThan(15_000)
		expect(provider.seen[2]).toBeLessThanOrEqual(15_000)
		expect(result.result).toBe('answered after relief')
		expect(result.stopReason).toBe('end_turn')
	})

	it('(b) clears an oversized tool result inside the verbatim recent window', async () => {
		const huge = 'r'.repeat(200_000)
		const messages: Message[] = [
			createUserMessage('read the log'),
			createAssistantMessage(null, [
				{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
			]),
			createToolMessage(huge, 'call-1'),
			createUserMessage('now summarise it'),
		]
		const provider = new OverflowingProvider(20_000)
		const result = await run(provider, messages)

		expect(result.result).toBe('answered after relief')
		expect(provider.seen.at(-1)).toBeLessThanOrEqual(20_000)
	})

	it('(c) relieves an overflow worded "context window"', async () => {
		const provider = new OverflowingProvider(
			20_000,
			'The request is larger than the model context window of 8192 tokens',
		)
		const result = await run(provider, exchanges(12, 1_500))

		expect(result.result).toBe('answered after relief')
		expect(provider.seen.length).toBeGreaterThanOrEqual(2)
	})

	it('stops after two reliefs when the prompt cannot be reduced', async () => {
		// A paste in the newest message that no pass can shed.
		const messages = exchanges(10, 500)
		messages.push(createUserMessage(`paste: ${'p'.repeat(60_000)}`))
		const provider = new OverflowingProvider(20_000)
		const result = await run(provider, messages)

		expect(result.status).toBe('failed')
		// The overflow, then one retry after each of the two rungs.
		expect(provider.seen.length).toBeLessThanOrEqual(3)
	})

	it('says why compaction could not help when the host reducer failed', async () => {
		const provider = new OverflowingProvider(20_000)
		const result = await run(provider, exchanges(10, 3_000), {}, () => {
			throw new Error('reducer backend down')
		})

		expect(result.status).toBe('failed')
		expect(JSON.stringify(result)).toContain('automatic compaction failed: reducer backend down')
	})
})
