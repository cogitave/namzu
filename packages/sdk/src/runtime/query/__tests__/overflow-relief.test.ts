import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * `context_length_exceeded` is the one provider failure the kernel can act
 * on. It is correctly non-retryable — resending the identical prompt
 * cannot help — and the kernel classified it precisely and then let the
 * run die, while holding a compaction subsystem that could have made room.
 *
 * The threshold path guesses when to compact and can guess low, so this is
 * not a hypothetical: a run carrying images, or a language the
 * chars-per-token ratio does not fit, reaches the real window while still
 * reading as comfortable.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** Overflows until the prompt shrinks, then answers. */
class OverflowingProvider extends MockLLMProvider {
	seen: number[] = []
	constructor(private readonly limitChars: number) {
		super({ turns: [{ text: 'answered after relief' }] })
	}

	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const size = params.messages.reduce(
			(n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
			0,
		)
		this.seen.push(size)
		if (size > this.limitChars) {
			throw Object.assign(new Error('prompt is too long for this model: context_length_exceeded'), {
				status: 400,
			})
		}
		yield* super.chatStream(params)
	}
}

async function run(provider: MockLLMProvider, compaction: boolean) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-overflow-'))
	dirs.push(workingDirectory)

	// A history big enough that shedding it changes the prompt size.
	const messages = Array.from({ length: 12 }, (_, i) =>
		createUserMessage(`turn ${i}: ${'context '.repeat(400)}`),
	)

	return drainQuery({
		provider,
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 20_000,
			tokenBudget: 500_000,
			maxIterations: 6,
			maxResponseTokens: 256,
		},
		agentId: 'agent_o',
		agentName: 'Overflow',
		messages,
		workingDirectory,
		sessionId: 'ses_o' as SessionId,
		topicId: 'top_o' as ThreadId,
		projectId: 'prj_o' as ProjectId,
		tenantId: 'tnt_o' as TenantId,
		retry: false,
		...(compaction
			? {
					compactionConfig: {
						strategy: 'structured' as const,
						triggerThreshold: 0.7,
						resetThreshold: 0.4,
						keepRecentMessages: 2,
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
					},
				}
			: {}),
	})
}

describe('a context overflow is relieved rather than fatal', () => {
	it('compacts and completes instead of dying', async () => {
		const provider = new OverflowingProvider(20_000)
		const result = await run(provider, true)

		// Two attempts: the one that overflowed, and the one after relief.
		expect(provider.seen.length).toBeGreaterThanOrEqual(2)
		expect(provider.seen[1]).toBeLessThan(provider.seen[0] as number)
		expect(result.result).toBe('answered after relief')
		expect(result.stopReason).toBe('end_turn')
	})

	it('still fails when there is no compaction configured to shed with', async () => {
		// Relief must not be claimed when nothing can be shed — retrying
		// would send the identical prompt and arrive at the identical error.
		const provider = new OverflowingProvider(20_000)
		const result = await run(provider, false)

		expect(result.status).toBe('failed')
		expect(provider.seen).toHaveLength(1)
	})

	it('does not interfere with a run that never overflows', async () => {
		const provider = new OverflowingProvider(10_000_000)
		const result = await run(provider, true)

		expect(provider.seen).toHaveLength(1)
		expect(result.result).toBe('answered after relief')
	})
})
