import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { createUserMessage } from '../../../types/message/index.js'
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
		toolsets: [],
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

const usageOf = (completionTokens: number) => ({
	promptTokens: 10,
	completionTokens,
	totalTokens: 10 + completionTokens,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})

/**
 * A thinking model: unless reasoning is switched off for the request it spends
 * `reasoningCost` tokens thinking before the first word of the answer, and an
 * allowance smaller than that ends in "length" with nothing written.
 */
function thinkingModel(
	reasoningCost: number,
	extra: Partial<LLMProvider> = {},
	honoursControls = true,
) {
	const requests: import('../../../types/provider/index.js').ChatCompletionParams[] = []
	const provider: LLMProvider = {
		id: 'thinker',
		name: 'thinker',
		async *chatStream(params) {
			requests.push(params)
			const side = params.messages[0]?.content === input.system
			if (!side) {
				yield { id: 'm', delta: { content: 'answer' }, usage: usageOf(5), finishReason: 'stop' }
				return
			}
			const off =
				honoursControls && (params.thinking?.type === 'disabled' || params.effort === 'none')
			const budget = params.maxTokens ?? 0
			if (!off && budget <= reasoningCost) {
				yield {
					id: 's',
					delta: {},
					usage: usageOf(budget),
					finishReason: 'length',
				}
				return
			}
			yield {
				id: 's',
				delta: { content: 'LABEL' },
				usage: usageOf(off ? 3 : reasoningCost + 3),
				finishReason: 'stop',
			}
		},
		...extra,
	}
	return { provider, requests }
}

const answers: string[] = []
const side = (maxTokens: number) =>
	[
		async ({ generateText }: PrepareStepContext) => {
			const completion = await generateText!({ ...input, maxTokens })
			answers.push(`${completion.finishReason}:${completion.text}`)
			return undefined
		},
	] as PrepareStepChain

it('asks a side request for no reasoning and never inherits the turn effort', async () => {
	const { provider, requests } = thinkingModel(700)
	await run(side(512), [], { provider })
	expect(requests).toHaveLength(2)
	expect(requests[0]?.thinking).toEqual({ type: 'disabled' })
	// The turn was configured with effort "low"; the side request is not the turn.
	expect(requests[0]?.effort).toBeUndefined()
	expect(answers.at(-1)).toBe('stop:LABEL')
	// The turn's own request still carries the turn's settings.
	expect(requests[1]?.effort).toBe('low')
	expect(requests[1]?.thinking).toBeUndefined()
})

it('sends effort none to a driver that lists it', async () => {
	const { provider, requests } = thinkingModel(700, {
		reasoningEffortLevelsFor: () => ['none', 'low', 'high'],
	})
	await run(side(60), [], { provider })
	expect(requests[0]).toMatchObject({
		thinking: { type: 'disabled' },
		effort: 'none',
		maxTokens: 60,
	})
})

it('leaves room for reasoning when the model cannot be told to stop', async () => {
	const { provider, requests } = thinkingModel(700, {
		reasoningEffortLevelsFor: () => ['low', 'medium', 'high'],
	})
	await run(side(512), [], { provider })
	expect(requests[0]?.effort).toBe('low')
	expect(requests[0]?.maxTokens).toBeGreaterThan(700)
	expect(answers.at(-1)).toBe('stop:LABEL')
})

it('reports the finish reason so a caller can tell a cut-off answer', async () => {
	// A driver that ignores every control and always thinks too long.
	const { provider } = thinkingModel(10_000, {}, false)
	await run(side(512), [], { provider })
	expect(answers.at(-1)).toBe('length:')
})
