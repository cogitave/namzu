import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, LLMProvider } from '../../../types/provider/index.js'
import type { PrepareStepChain } from '../../../types/session/prepare-step.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A turn's optional inference is bounded by the turn, not by itself.
 *
 * The defect this file exists for: the bounded auxiliary inference carried its
 * own deadline and aborted the request when it fired. An aborted request has no
 * final usage receipt, so the shared ledger retained it as unresolved — and an
 * account with unresolved spend admits nothing further. The operator's turn
 * died with "usage for a model request could not be confirmed" before the model
 * was ever asked, which reads as a broken provider and is really a deadline the
 * run imposed on its own optional call.
 *
 * Measured against a real free OpenRouter model: the auxiliary call took
 * 17.3 s, the deadline fired at 10.0 s, and the turn stopped 10.0 s after the
 * operator's message — the same stop, to the second, in every turn after the
 * first. A deadline shorter than an ordinary answer time cannot be enforced
 * here at all, so it no longer bounds the request: the two bounds that remain
 * are the provider's own request timeout and the turn's cancellation, which is
 * exactly what every other model request in the turn has.
 */

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

/** A provider whose auxiliary answer arrives well after the deadline it was given. */
function slowAuxiliaryProvider(delayMs: number) {
	const requests: ChatCompletionParams[] = []
	const provider: LLMProvider = {
		id: 'mock',
		name: 'mock',
		async *chatStream(params) {
			requests.push(params)
			const auxiliary = params.messages[0]?.content === input.system
			if (auxiliary) await new Promise((resolve) => setTimeout(resolve, delayMs))
			yield { id: 'a', delta: { content: auxiliary ? 'plan' : 'answer' }, usage: usage(10) }
			yield { id: 'a', delta: {}, finishReason: 'stop' as const }
		},
	}
	return { provider, requests }
}

async function run(prepareStep: PrepareStepChain, provider: LLMProvider) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-auxiliary-deadline-'))
	dirs.push(workingDirectory)
	return drainQuery({
		provider,
		toolsets: [],
		prepareStep,
		retry: false,
		agentId: 'prepare',
		agentName: 'Preparation',
		workingDirectory,
		messages: [createUserMessage('PRIVATE operator context, not an auxiliary input')],
		turnConfig: {
			model: 'main-model',
			tokenBudget: 1_000,
			maxIterations: 2,
			timeoutMs: 3_000,
		},
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
	})
}

it('completes the turn when the optional inference outlives the deadline it was given', async () => {
	const { provider, requests } = slowAuxiliaryProvider(50)
	const result = await run(async ({ generateText }) => {
		// A deadline this answer cannot meet. It is no longer a bound on the
		// request: racing it against a contacted provider call is what left the
		// shared ledger unresolved and stopped the turn.
		await generateText!({ ...input, timeoutMs: 10 })
		return undefined
	}, provider)

	// The main model was asked. This is the assertion the defect failed: the turn
	// stopped at its first iteration boundary and never reached this call.
	expect(requests).toHaveLength(2)
	expect(requests[1]?.messages[0]?.content).not.toBe(input.system)
	expect(result.stopReason).toBe('end_turn')
	expect(result.budget?.unresolvedRequests).toBe(0)
	expect(result.budget?.poisoned).toBe(false)
	expect(result.budget?.treeTokens).toBe(20)
})
