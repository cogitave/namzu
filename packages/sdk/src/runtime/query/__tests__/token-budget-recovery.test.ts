import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DiskTokenBudgetStore, openTokenBudget } from '../../../store/run/token-budget-disk.js'
import type { TokenUsage } from '../../../types/common/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const directories: string[] = []
afterEach(async () => {
	await removeTempDirs(directories.splice(0))
})
const usage = (tokens: number): TokenUsage => ({
	promptTokens: tokens,
	completionTokens: 0,
	totalTokens: tokens,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})

async function recovery(mode: 'retry' | 'fallback' | 'auth', measured: number) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-budget-recovery-'))
	directories.push(workingDirectory)
	const scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		runId: generateRunId(),
	}
	const baseDir = join(workingDirectory, 'ledgers')
	const budget = await openTokenBudget({
		store: new DiskTokenBudgetStore({ baseDir }),
		scope,
		limit: 1_000,
	})
	let calls = 0
	const primary: LLMProvider = {
		id: 'primary',
		name: 'Primary',
		async *chatStream(): AsyncIterable<StreamChunk> {
			calls++
			if (measured) yield { id: 'partial-usage', delta: {}, usage: usage(measured) }
			throw new ProviderError({
				code: mode === 'auth' ? 'auth' : 'network',
				message: 'scripted request failure',
			})
		},
	}
	const fallback = new MockLLMProvider({ turns: [{ text: 'fallback answered', usage: usage(50) }] })
	const run = await drainQuery({
		...scope,
		topicId: generateTopicId(),
		workingDirectory,
		provider: primary,
		budget,
		tools: new ToolRegistry(),
		fallbackProviders: mode === 'retry' ? [] : [{ provider: fallback }],
		retry: mode === 'retry' ? { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 } : false,
		runConfig: { model: 'mock', timeoutMs: 10_000, tokenBudget: 1_000, maxIterations: 2 },
		agentId: 'recovery-budget',
		agentName: 'Recovery budget',
		messages: [createUserMessage('Answer the request.')],
	})
	const recorded = await new DiskTokenBudgetStore({ baseDir }).load(scope)
	return { calls, fallback, run, recorded }
}

describe('each actual provider attempt requires budget authority', () => {
	it.each([
		{ mode: 'retry' as const, measured: 0 },
		{ mode: 'fallback' as const, measured: 0 },
		{ mode: 'fallback' as const, measured: 120 },
	])(
		'retains uncertain spend before $mode after $measured reported tokens',
		async ({ mode, measured }) => {
			const result = await recovery(mode, measured)
			expect(result.calls).toBe(1)
			expect(result.fallback.requests).toHaveLength(0)
			expect(result.run.stopReason).not.toBe('end_turn')
			expect(result.run.tokenUsage.totalTokens).toBe(measured)
			expect(result.recorded?.requests[0]?.unresolved).toBe(true)
			expect(result.recorded?.requests).toHaveLength(1)
			expect(result.recorded?.completedRequests).toHaveLength(0)
		},
	)

	it('permits a fallback after a known rejection before generation', async () => {
		const result = await recovery('auth', 0)
		expect(result.calls).toBe(1)
		expect(result.fallback.requests).toHaveLength(1)
		expect(result.run.result).toBe('fallback answered')
		expect(result.run.tokenUsage.totalTokens).toBe(50)
		expect(result.recorded?.requests).toHaveLength(0)
		expect(result.recorded?.completedRequests).toHaveLength(2)
	})
})
