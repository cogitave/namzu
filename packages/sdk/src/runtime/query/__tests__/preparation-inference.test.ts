import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createUserMessage } from '../../../types/message/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { LLMProvider, MockTurn } from '../../../types/provider/index.js'
import type { PrepareStepChain, PrepareStepContext } from '../../../types/session/prepare-step.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})
const usage = (totalTokens: number) => ({
	promptTokens: totalTokens,
	completionTokens: 0,
	totalTokens,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})
const input = { system: 'Return one short search label.', prompt: 'Resolve this reference.' }
async function run(
	prepareStep: PrepareStepChain,
	turns: MockTurn[],
	extras: { budget?: number; provider?: LLMProvider; fallback?: LLMProvider } = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-preparation-inference-'))
	dirs.push(workingDirectory)
	const provider = new MockLLMProvider({ turns })
	const result = await drainQuery({
		provider: extras.provider ?? provider,
		tools: new ToolRegistry(),
		prepareStep,
		...(extras.fallback
			? { fallbackProviders: [{ provider: extras.fallback, model: 'fallback-model' }] }
			: {}),
		retry: false,
		agentId: 'prepare',
		agentName: 'Preparation',
		workingDirectory,
		messages: [createUserMessage('PRIVATE operator context, not an auxiliary input')],
		turnConfig: {
			model: 'main-model',
			effort: 'low',
			tokenBudget: extras.budget ?? 1000,
			maxIterations: 2,
			timeoutMs: 3000,
		},
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
	})
	return { result, provider }
}

it('selects final structured text without mixing in commentary and retains all usage', async () => {
	let calls = 0
	const provider = new MockLLMProvider()
	provider.chatStream = async function* () {
		if (calls++ === 0) {
			yield { id: 'plan', delta: { content: 'I will resolve this.' } }
			yield { id: 'plan', delta: { content: '{"mode":"none"}' } }
			yield {
				id: 'plan',
				delta: {},
				usage: usage(100),
				textParts: [
					{ id: 'p', phase: 'commentary', text: 'I will resolve this.' },
					{ id: 'f', phase: 'final_answer', text: '{"mode":"none"}' },
				],
			}
		} else
			yield { id: 'main', delta: { content: 'answer' }, usage: usage(20), finishReason: 'stop' }
	}
	const { result } = await run(
		async ({ generateText }) => {
			const completion = await generateText!(input)
			expect(JSON.parse(completion.text)).toEqual({ mode: 'none' })
			return undefined
		},
		[],
		{ provider },
	)
	expect(result.tokenUsage.totalTokens).toBe(120)
	expect(JSON.stringify(result.messages)).not.toContain('I will resolve this.')
})

it('meters auxiliary inference, follows preceding model selection, and leaves history untouched', async () => {
	const { result, provider } = await run(
		[
			() => ({ model: 'selected-model' }),
			async ({ generateText }) => {
				const completion = await generateText!({ ...input, maxTokens: 128 })
				expect(completion.servedBy).toMatchObject({ providerId: 'mock', model: 'selected-model' })
				return { context: completion.text }
			},
		],
		[
			{ text: 'QUERY_LABEL', usage: usage(100) },
			{ text: 'answer', usage: usage(20) },
		],
	)
	expect(provider.requests).toHaveLength(2)
	expect(provider.requests[0]).toMatchObject({
		model: 'selected-model',
		effort: 'low',
		maxTokens: 128,
	})
	expect(provider.requests[0]!.tools).toBeUndefined()
	expect(provider.requests[0]!.messages.map((m) => m.content)).toEqual([input.system, input.prompt])
	expect(JSON.stringify(provider.requests[1]!.messages)).toContain('QUERY_LABEL')
	expect(JSON.stringify(result.messages)).not.toContain('QUERY_LABEL')
	expect(result.tokenUsage.totalTokens).toBe(120)
	expect(result.budget?.treeTokens).toBe(120)
	expect(result.steps?.[0]?.usage.totalTokens).toBe(20)
})

it('does not admit the main call after preparation exhausts the shared budget', async () => {
	const { provider, result } = await run(
		async ({ generateText }) => {
			await generateText!(input)
			return undefined
		},
		[
			{ text: 'plan', usage: usage(100) },
			{ text: 'must not run', usage: usage(20) },
		],
		{ budget: 50 },
	)
	expect(provider.requests).toHaveLength(1)
	expect(result.budget?.treeTokens).toBe(100)
})

it('revokes the captured capability at stage completion and refuses a second call', async () => {
	let retained: PrepareStepContext['generateText']
	const { provider } = await run(
		async ({ generateText }) => {
			retained = generateText
			await generateText!(input)
			await expect(generateText!(input)).rejects.toThrow('only one')
			return undefined
		},
		[
			{ text: 'plan', usage: usage(10) },
			{ text: 'answer', usage: usage(20) },
		],
	)
	await expect(retained!(input)).rejects.toThrow('stage has ended')
	expect(provider.requests).toHaveLength(2)
})

it.each([
	{ ...input, maxTokens: 1025 },
	{ ...input, timeoutMs: 10001 },
	{ system: 'S'.repeat(6001), prompt: 'P'.repeat(6000) },
])('rejects oversized inputs before spending a model call', async (request) => {
	const { provider } = await run(
		async ({ generateText }) => {
			await expect(generateText!(request)).rejects.toThrow()
			return undefined
		},
		[{ text: 'answer', usage: usage(20) }],
	)
	expect(provider.requests).toHaveLength(1)
})

it.each([
	{ text: 'x'.repeat(8193), usage: usage(80) },
	{ toolCalls: [{ name: 'write_file', args: { path: 'forbidden' } }], usage: usage(80) },
])('drains invalid output for measured usage without executing it', async (turn) => {
	const { provider, result } = await run(
		async ({ generateText }) => {
			await expect(generateText!(input)).rejects.toThrow(/output exceeds|cannot call tools/)
			return undefined
		},
		[turn, { text: 'answer', usage: usage(20) }],
	)
	expect(provider.requests).toHaveLength(2)
	expect(result.tokenUsage.totalTokens).toBe(100)
	expect(result.budget?.unresolvedRequests).toBe(0)
})

it('uses the existing fallback chain for the preparation call', async () => {
	const primary = new MockLLMProvider({
		nextTurn: () => {
			throw new ProviderError({ code: 'rate_limit', message: 'limited' })
		},
	})
	const fallback = new MockLLMProvider({
		turns: [
			{ text: 'plan', usage: usage(40) },
			{ text: 'answer', usage: usage(20) },
		],
	})
	const { result } = await run(
		async ({ generateText }) => {
			const response = await generateText!(input)
			expect(response.servedBy).toMatchObject({ model: 'fallback-model', chainIndex: 1 })
			return undefined
		},
		[],
		{ provider: primary, fallback },
	)
	expect(primary.requests).toHaveLength(1)
	expect(fallback.requests).toHaveLength(2)
	expect(result.tokenUsage.totalTokens).toBe(60)
})

it('cancels a noncooperative preparation stream without admitting more spend', async () => {
	const controller = new AbortController()
	const contacted = vi.fn()
	const provider: LLMProvider = {
		id: 'mock',
		name: 'mock',
		async *chatStream() {
			contacted()
			controller.abort(new Error('caller stopped'))
			await new Promise(() => {})
		},
	}
	const { result } = await run(
		async ({ generateText }) => {
			await expect(generateText!({ ...input, signal: controller.signal })).rejects.toThrow(
				'caller stopped',
			)
			return undefined
		},
		[],
		{ provider },
	)
	expect(contacted).toHaveBeenCalledOnce()
	expect(result.budget?.inFlightRequests).toBe(1)
	expect(result.budget?.unresolvedRequests).toBe(1)
})
