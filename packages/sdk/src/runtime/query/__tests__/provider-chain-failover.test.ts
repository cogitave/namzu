/**
 * The chain reaches the RUN, not just the decorator.
 *
 * `provider/__tests__/fallback.test.ts` proves `withProviderFallback` behaves.
 * Every one of those tests still passes with `query()` ignoring
 * `fallbackProviders` entirely — a unit test on a helper says nothing about
 * whether the caller invokes it
 * (`docs/conventions/mutation-check-every-test.md`). So this file drives
 * `query()` itself and asserts on the run's own events.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { failingStream } from '../../../__fixtures__/failing-stream.js'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/** A provider that always fails the way `status` says. */
function failing(id: string, status: number): LLMProvider & { calls: number } {
	let calls = 0
	return {
		id,
		name: id,
		chatStream: (_params: ChatCompletionParams): AsyncIterable<StreamChunk> => {
			calls++
			return failingStream(Object.assign(new Error(`HTTP ${status}`), { status }))
		},
		get calls() {
			return calls
		},
	} as unknown as LLMProvider & { calls: number }
}

function baseParams(provider: LLMProvider, tools: ToolRegistry, workingDirectory: string) {
	return {
		provider,
		tools,
		runConfig: {
			model: 'primary-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			maxIterations: 1,
			maxResponseTokens: 256,
		},
		agentId: 'agent_test',
		agentName: 'Test Agent',
		workingDirectory,
		sessionId: 'ses_chain' as SessionId,
		topicId: 'top_chain' as ThreadId,
		projectId: 'prj_chain' as ProjectId,
		tenantId: 'tnt_chain' as TenantId,
		// No sleeping in a unit test: every fallover here is on a code the retry
		// decorator declines anyway, but an accidental retryable status must not
		// park the suite for 16 seconds.
		retry: false as const,
	}
}

describe('query() drives the declared provider chain', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-chain-'))
		workdirs.push(dir)
		return dir
	}

	it('falls over to a declared member and finishes the run on it', async () => {
		const primary = failing('primary', 401)
		const fallback = new MockLLMProvider({ turns: [{ text: 'the fallback answered' }] })
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...baseParams(primary, new ToolRegistry(), await mkWorkdir()),
				fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
				messages: [createUserMessage('hello')],
			},
			(e) => {
				events.push(e)
			},
		)

		expect(run.status).toBe('completed')
		expect(events.some((e) => e.type === 'text_delta')).toBe(true)

		const swap = events.find((e) => e.type === 'provider_fallback')
		expect(swap).toMatchObject({
			type: 'provider_fallback',
			fromIndex: 0,
			fromProviderId: 'primary',
			toIndex: 1,
			toProviderId: fallback.id,
			toModel: 'fallback-model',
			code: 'auth',
			status: 401,
		})
	})

	it('emits nothing new and behaves exactly as before when no chain is declared', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
				messages: [createUserMessage('hello')],
			},
			(e) => {
				events.push(e)
			},
		)

		expect(run.status).toBe('completed')
		expect(events.some((e) => e.type === 'provider_fallback')).toBe(false)
	})

	/**
	 * The chain's cost question, answered by refusal rather than by a blended
	 * number. See `assertCostIsAttributable` for the argument; this pins that the
	 * refusal is reachable and names both things the caller loses.
	 */
	it('refuses a chain declared with a single pricing table', async () => {
		const primary = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		const fallback = new MockLLMProvider({ turns: [{ text: 'ok' }] })

		await expect(
			drainQuery({
				...baseParams(primary, new ToolRegistry(), await mkWorkdir()),
				fallbackProviders: [{ provider: fallback }],
				pricing: { inputCostPer1M: 3, outputCostPer1M: 15 },
				messages: [createUserMessage('hello')],
			}),
		).rejects.toThrow(/one table cannot price two members/i)
	})

	it('still accepts pricing when only one provider is declared', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })

		const run = await drainQuery({
			...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
			pricing: { inputCostPer1M: 3, outputCostPer1M: 15 },
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')
	})
})
