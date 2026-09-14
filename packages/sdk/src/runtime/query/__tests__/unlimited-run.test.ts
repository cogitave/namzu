import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { RuntimeConfigSchema } from '../../../config/runtime.js'
import { RunConfigSchema } from '../../../contracts/schemas.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/index.js'
import { checkLimitsDetailed } from '../../../run/LimitChecker.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { createUserMessage } from '../../../types/message/index.js'
import { GuardCoordinator } from '../guard.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => removeTempDirs(dirs.splice(0)))

it.each([
	{ maxIterations: 0, tokenBudget: 0, expectedRequests: 53, expectedStop: 'end_turn' },
	{ maxIterations: 3, tokenBudget: 0, expectedRequests: 3, expectedStop: 'max_iterations' },
	{ maxIterations: 0, tokenBudget: 300_000, expectedRequests: 3, expectedStop: 'token_budget' },
])('meters work and only stops for explicit guards: %j', async (test) => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-unlimited-run-'))
	dirs.push(workingDirectory)
	const provider = new MockLLMProvider({
		nextTurn: (_request, index) => ({
			...(index < 52
				? { toolCalls: [{ name: 'observe', args: { index } }] }
				: { text: 'finished' }),
			usage: { promptTokens: 99_999, completionTokens: 1 },
		}),
	})
	let observations = 0
	const tools = new ToolRegistry()
	tools.register({
		name: 'observe',
		description: 'Observe the next numbered sample.',
		inputSchema: z.object({ index: z.number() }),
		execute: async () => ({ success: true, output: String(++observations) }),
	})
	const run = await drainQuery({
		workingDirectory,
		provider,
		tools,
		retry: false,
		agentId: 'limit-test',
		agentName: 'Limit test',
		tenantId: fixtureId.tenant('unlimited-run'),
		projectId: fixtureId.project('unlimited-run'),
		topicId: fixtureId.topic('unlimited-run'),
		sessionId: fixtureId.session('unlimited-run'),
		runStore: new InMemoryRunStore(),
		runConfig: {
			model: 'mock',
			timeoutMs: 0,
			tokenBudget: test.tokenBudget,
			maxIterations: test.maxIterations,
			checkpointEvery: 20,
		},
		messages: [createUserMessage('Observe every sample, then finish.')],
	})
	expect(provider.requests).toHaveLength(test.expectedRequests)
	expect(run.stopReason).toBe(test.expectedStop)
	expect(run.tokenUsage.totalTokens).toBe(test.expectedRequests * 100_000)
	expect(run.budget).toMatchObject({
		ownTokens: test.expectedRequests * 100_000,
		treeTokens: test.expectedRequests * 100_000,
		remainingTokens: test.tokenBudget === 0 ? null : 0,
		unresolvedRequests: 0,
	})
	if (test.expectedStop === 'end_turn') {
		expect(observations).toBe(52)
		expect(run.result).toBe('finished')
	}
})

it('an unlimited run keeps cancellation and optional cost limits', () => {
	const config = { tokenBudget: 0, timeoutMs: 0, maxIterations: 0, budgetWarningThreshold: 0.9 }
	const state = {
		aborted: false,
		totalTokens: 8_000_000,
		totalCost: 100,
		unpricedTokens: 0,
		currentIteration: 10_000,
		startTime: Date.now() - 24 * 60 * 60 * 1000,
	}
	expect(checkLimitsDetailed(config, state)).toEqual({ type: 'ok' })
	expect(checkLimitsDetailed(config, { ...state, aborted: true })).toEqual({
		type: 'hard_stop',
		reason: 'cancelled',
	})
	expect(checkLimitsDetailed({ ...config, costLimitUsd: 99 }, state)).toEqual({
		type: 'hard_stop',
		reason: 'cost_limit',
	})
	const guard = new GuardCoordinator(config)
	guard.restoreElapsed(24 * 60 * 60 * 1000)
	expect(guard.remainingBeforeFinalizeMs()).toBe(Number.POSITIVE_INFINITY)
	expect(guard.remainingUntilTimeoutMs()).toBe(Number.POSITIVE_INFINITY)
})

it('configuration schemas accept unlimited without changing omitted defaults', () => {
	expect(
		RuntimeConfigSchema.parse({ tokenBudget: 0, maxIterations: 0, timeoutMs: 0 }),
	).toMatchObject({ tokenBudget: 0, maxIterations: 0, timeoutMs: 0 })
	expect(RuntimeConfigSchema.parse({})).toMatchObject({
		tokenBudget: 100_000,
		maxIterations: 200,
		timeoutMs: 600_000,
	})
	expect(RunConfigSchema.parse({ timeoutMs: 0 })).toEqual({ timeoutMs: 0 })
})
