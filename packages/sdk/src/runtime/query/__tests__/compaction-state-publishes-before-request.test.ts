import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ChatCompletionParams, LLMProvider } from '../../../types/provider/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import { query } from '../index.js'

/**
 * A context edit is complete before the next model request starts. Its event
 * and status snapshot therefore have to cross the query generator boundary
 * first; otherwise a slow or failing provider leaves every host displaying
 * state the kernel already destroyed.
 */

const workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

function longHistory(): Message[] {
	return Array.from({ length: 12 }, (_, index) => [
		createUserMessage(`question ${index} `.repeat(80)),
		createAssistantMessage(`answer ${index} `.repeat(80)),
	]).flat()
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

function recordingProvider(): {
	provider: LLMProvider
	chatCalls: () => number
} {
	const delegate = new MockLLMProvider({ turns: [{ text: 'main response' }] })
	let calls = 0
	return {
		provider: {
			id: delegate.id,
			name: delegate.name,
			capabilities: delegate.capabilities,
			chatStream(params: ChatCompletionParams) {
				calls++
				return delegate.chatStream(params)
			},
		},
		chatCalls: () => calls,
	}
}

async function runUntilCompactionSnapshot(options: {
	strategy: 'structured' | 'sliding-window'
	messages: Message[]
	contextWindowTokens: number
	clearToolResults?: boolean
}): Promise<{
	events: RunEvent[]
	usage: Extract<RunEvent, { type: 'token_usage_updated' }>
	chatCalls: number
	prepareStepCalls: number
}> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-compaction-status-'))
	workdirs.push(dir)
	const recorded = recordingProvider()
	let prepareStepCalls = 0
	const iterator = query({
		provider: recorded.provider,
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 20_000,
			tokenBudget: 100_000,
			maxIterations: 1,
			maxResponseTokens: 256,
		},
		agentId: 'agent_compaction_status',
		agentName: 'Compaction Status Agent',
		messages: options.messages,
		workingDirectory: dir,
		sessionId: fixtureId.session('compaction_status'),
		topicId: fixtureId.topic('compaction_status'),
		projectId: fixtureId.project('compaction_status'),
		tenantId: fixtureId.tenant('compaction_status'),
		retry: false,
		resumeHandler: autoApproveHandler,
		prepareStep: async () => {
			prepareStepCalls++
			// An opaque host wait between compaction and provider admission. The
			// status transition must cross the generator boundary before this
			// callback can hold the run.
			await new Promise((resolve) => setTimeout(resolve, 40))
			return {}
		},
		compactionConfig: CompactionConfigSchema.parse({
			strategy: options.strategy,
			contextWindowTokens: options.contextWindowTokens,
			triggerThreshold: 0.1,
			resetThreshold: 0.05,
			keepRecentMessages: 2,
			llmVerification: false,
			clearToolResults: options.clearToolResults ?? false,
			keepRecentToolResults: 0,
			minToolResultCharsToClear: 1_000,
		}),
	})

	const events: RunEvent[] = []
	try {
		for (;;) {
			const next = await iterator.next()
			if (next.done)
				throw new Error(`run settled before the compaction snapshot: ${next.value.status}`)
			events.push(next.value)
			if (next.value.type === 'token_usage_updated') {
				return {
					events,
					usage: next.value,
					chatCalls: recorded.chatCalls(),
					prepareStepCalls,
				}
			}
		}
	} finally {
		await iterator.return(undefined as unknown as Run)
	}
}

describe('automatic compaction publishes its state before the next request', () => {
	it.each(['sliding-window', 'structured'] as const)(
		'publishes a %s reduction and exact cumulative counters first',
		async (strategy) => {
			const result = await runUntilCompactionSnapshot({
				strategy,
				messages: longHistory(),
				contextWindowTokens: 1_000,
			})

			const completed = result.events.find(
				(event): event is Extract<RunEvent, { type: 'compaction_completed' }> =>
					event.type === 'compaction_completed',
			)
			expect(completed).toBeDefined()
			expect(
				result.chatCalls,
				'the model request began before the status snapshot was yielded',
			).toBe(0)
			expect(
				result.prepareStepCalls,
				'a host callback began before the status transition crossed the generator boundary',
			).toBe(0)
			expect(result.usage.contextTokens).toBe(completed?.tokensAfter)
			expect(result.usage.contextMeasuredBy).toBe('estimate')
			expect(result.usage.contextWindowTokens).toBe(1_000)
			expect(result.usage.windowSource).toBe('config')
			expect(result.usage.usage).toEqual({
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			})
			expect(result.usage.cost).toMatchObject({
				totalCost: 0,
				cacheDiscount: 0,
			})
		},
	)

	it('publishes a clear-only edit before the next request too', async () => {
		const result = await runUntilCompactionSnapshot({
			strategy: 'structured',
			messages: [
				...toolTurn('old-1', 80_000),
				...toolTurn('old-2', 80_000),
				...longHistory().slice(-4),
			],
			contextWindowTokens: 40_000,
			clearToolResults: true,
		})

		const cleared = result.events.find(
			(event): event is Extract<RunEvent, { type: 'compaction_tool_results_cleared' }> =>
				event.type === 'compaction_tool_results_cleared',
		)
		expect(cleared?.reliefWasEnough).toBe(true)
		expect(result.events.some((event) => event.type === 'compaction_completed')).toBe(false)
		expect(result.chatCalls, 'the model request began before the clear snapshot was yielded').toBe(
			0,
		)
		expect(result.prepareStepCalls).toBe(0)
		expect(result.usage.contextMeasuredBy).toBe('estimate')
		expect(result.usage.contextTokens).toBeLessThan(40_000 * 0.1)
	})
})
