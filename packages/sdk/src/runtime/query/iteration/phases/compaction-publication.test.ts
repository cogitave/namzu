import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import { EMPTY_TOKEN_USAGE, ZERO_COST } from '../../../../constants/limits.js'
import type { RunId } from '../../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../../types/provider/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { measureContext, runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

interface Deferred<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function logger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as Logger
}

function toolTurn(id: string, chars: number): Message[] {
	return [
		createUserMessage(`read ${id}`),
		{
			role: 'assistant',
			content: '',
			toolCalls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
		} as Message,
		{ role: 'tool', toolCallId: id, content: 'x'.repeat(chars) } as Message,
	]
}

function completed(content: string): StreamChunk[] {
	return [
		{ id: 'verifier', delta: { content } },
		{
			id: 'verifier',
			delta: {},
			finishReason: 'stop',
			usage: {
				promptTokens: 3,
				completionTokens: 2,
				totalTokens: 5,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
		},
	]
}

describe('compaction publication is one coherent transition', () => {
	it('keeps an insufficient clear staged while summary verification is pending', async () => {
		const config = CompactionConfigSchema.parse({
			strategy: 'structured',
			contextWindowTokens: 40_000,
			triggerThreshold: 0.1,
			resetThreshold: 0.05,
			keepRecentMessages: 2,
			clearToolResults: true,
			keepRecentToolResults: 0,
			minToolResultCharsToClear: 1_000,
			llmVerification: true,
			richStateThreshold: 1_000,
		})
		const messages: Message[] = [
			createSystemMessage('system floor'),
			...toolTurn('old-result', 80_000),
			...Array.from({ length: 80 }, (_, index) => [
				createUserMessage(`question ${index} `.repeat(80)),
				createAssistantMessage(`answer ${index} `.repeat(80)),
			]).flat(),
		]
		const original = structuredClone(messages)
		const started = deferred<void>()
		const release = deferred<void>()
		let calls = 0
		const provider: LLMProvider = {
			id: 'held-verifier',
			name: 'Held verifier',
			chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				calls++
				return (async function* () {
					started.resolve()
					await release.promise
					for (const chunk of completed('COMPLETE')) yield chunk
				})()
			},
		}
		const events: RunEvent[] = []
		const usage = { ...EMPTY_TOKEN_USAGE }
		const clearLastPromptTokens = vi.fn()
		const ctx = {
			compactionConfig: config,
			workingStateManager: new WorkingStateManager(config),
			runConfig: { model: 'mock-model' },
			runMgr: {
				id: 'run_atomic_compaction' as RunId,
				currentIteration: 2,
				messages,
				tokenUsage: usage,
				costInfo: { ...ZERO_COST },
				servingProviderId: provider.id,
				lastPromptTokens: 50_000,
				lastPromptMessageCount: messages.length,
				clearLastPromptTokens,
				accumulateUsage(next: typeof usage) {
					Object.assign(usage, next)
				},
			},
			provider,
			tools: { toLLMTools: () => [] },
			abortController: new AbortController(),
			log: logger(),
			emitEvent: async (event: RunEvent) => {
				events.push(event)
			},
		} as unknown as IterationContext

		const running = runCompactionCheck(ctx)
		await started.promise

		expect(calls).toBe(1)
		expect(messages).toEqual(original)
		expect(events.filter((event) => event.type.startsWith('compaction_'))).toEqual([])
		expect(clearLastPromptTokens).not.toHaveBeenCalled()

		release.resolve()
		await running

		expect(messages).not.toEqual(original)
		expect(String(original[3]?.content)).toHaveLength(80_000)
		expect(
			events.map((event) => event.type).filter((type) => type.startsWith('compaction_')),
		).toEqual(['compaction_shed', 'compaction_tool_results_cleared', 'compaction_completed'])
		const snapshot = events.at(-1)
		expect(snapshot?.type).toBe('token_usage_updated')
		if (snapshot?.type !== 'token_usage_updated') throw new Error('missing status snapshot')
		expect(snapshot.usage.totalTokens).toBe(5)
		expect(snapshot.contextMeasuredBy).toBe('estimate')
		expect(clearLastPromptTokens).toHaveBeenCalledOnce()
	})

	it('invalidates the provider measurement when a clear alone is enough', async () => {
		const config = CompactionConfigSchema.parse({
			strategy: 'structured',
			contextWindowTokens: 40_000,
			triggerThreshold: 0.7,
			keepRecentMessages: 2,
			clearToolResults: true,
			keepRecentToolResults: 0,
			minToolResultCharsToClear: 1_000,
			llmVerification: false,
		})
		let lastPromptTokens: number | undefined = 40_000
		let lastPromptMessageCount: number | undefined
		const messages = [createSystemMessage('floor'), ...toolTurn('old', 80_000)]
		lastPromptMessageCount = messages.length
		const clearLastPromptTokens = vi.fn(() => {
			lastPromptTokens = undefined
			lastPromptMessageCount = undefined
		})
		const ctx = {
			compactionConfig: config,
			workingStateManager: new WorkingStateManager(config),
			runConfig: { model: 'mock-model' },
			runMgr: {
				id: 'run_clear_measurement' as RunId,
				currentIteration: 1,
				messages,
				tokenUsage: { ...EMPTY_TOKEN_USAGE },
				costInfo: { ...ZERO_COST },
				get lastPromptTokens() {
					return lastPromptTokens
				},
				get lastPromptMessageCount() {
					return lastPromptMessageCount
				},
				clearLastPromptTokens,
			},
			tools: { toLLMTools: () => [] },
			log: logger(),
			emitEvent: async () => {},
		} as unknown as IterationContext

		await runCompactionCheck(ctx)

		expect(clearLastPromptTokens).toHaveBeenCalledOnce()
		expect(measureContext(ctx).source).toBe('estimate')
	})
})
