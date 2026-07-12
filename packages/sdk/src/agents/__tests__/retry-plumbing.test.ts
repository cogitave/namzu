// Current-code invariants asserted (2026-07-12, ses_015 Phase A):
// - ReactiveAgent copies config.retry into the AgentRunConfig it builds, so the
//   runtime honors the agent-level retry policy: config.retry.maxAttempts caps
//   the physical provider attempts for a single logical call.
// - When config.retry is omitted, DEFAULT_RETRY_CONFIG applies (3 attempts).
// - ReactiveAgent.cancel() reaches the in-flight query: the agent composes its
//   own abortController with input.signal into the signal passed to query(), so
//   cancel() aborts a hung provider call and the run ends 'cancelled' (A6 fix).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderRequestError } from '../../provider/errors.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ReactiveAgentConfig } from '../../types/agent/index.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../types/provider/index.js'
import type { RetryConfig } from '../../types/run/index.js'
import { ReactiveAgent } from '../ReactiveAgent.js'

interface FakeProvider extends LLMProvider {
	calls: number
}

function alwaysServerError(): FakeProvider {
	const provider: FakeProvider = {
		id: 'fake',
		name: 'Fake',
		calls: 0,
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			provider.calls += 1
			throw new ProviderRequestError('server boom', { kind: 'server', providerId: 'fake' })
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
	return provider
}

function baseConfig(provider: LLMProvider, retry?: RetryConfig): ReactiveAgentConfig {
	return {
		model: 'm',
		tokenBudget: 1_000_000,
		timeoutMs: 600_000,
		maxIterations: 10,
		provider,
		tools: new ToolRegistry(),
		sessionId: 'ses_test' as SessionId,
		threadId: 'thr_test' as ThreadId,
		projectId: 'prj_test' as ProjectId,
		tenantId: 'tnt_test' as TenantId,
		retry,
	}
}

function makeAgent(): ReactiveAgent {
	return new ReactiveAgent({
		id: 'a1',
		name: 'A1',
		version: '1.0.0',
		category: 'test',
		description: 'test agent',
	})
}

describe('ReactiveAgent retry plumbing', () => {
	it('threads config.retry.maxAttempts into the runtime attempt cap', async () => {
		const provider = alwaysServerError()
		const agent = makeAgent()
		const retry: RetryConfig = {
			enabled: true,
			maxAttempts: 2,
			baseDelayMs: 0,
			maxDelayMs: 1000,
			overflowAttempts: 2,
		}

		const result = await agent.run(
			{
				messages: [createUserMessage('hi')],
				workingDirectory: mkdtempSync(join(tmpdir(), 'namzu-plumb-')),
			},
			baseConfig(provider, retry),
		)

		expect(result.status).toBe('failed')
		expect(provider.calls).toBe(2)
	})

	it('applies DEFAULT_RETRY_CONFIG (3 attempts) when config.retry is omitted', async () => {
		const provider = alwaysServerError()
		const agent = makeAgent()

		const result = await agent.run(
			{
				messages: [createUserMessage('hi')],
				workingDirectory: mkdtempSync(join(tmpdir(), 'namzu-plumb-')),
			},
			baseConfig(provider),
		)

		expect(result.status).toBe('failed')
		expect(provider.calls).toBe(3)
	})
})

describe('ReactiveAgent cancellation', () => {
	it('cancel() aborts an in-flight run via the composed signal', async () => {
		// Provider hangs until the run's signal aborts, then rejects 'aborted'.
		const provider: LLMProvider = {
			id: 'fake',
			name: 'Fake',
			chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
				return new Promise((_resolve, reject) => {
					params.signal?.addEventListener(
						'abort',
						() =>
							reject(new ProviderRequestError('aborted', { kind: 'aborted', providerId: 'fake' })),
						{ once: true },
					)
				})
			},
			// biome-ignore lint/correctness/useYield: stub, never invoked
			async *chatStream() {
				throw new Error('not used')
			},
		}
		const agent = makeAgent()

		const runPromise = agent.run(
			{
				messages: [createUserMessage('hi')],
				workingDirectory: mkdtempSync(join(tmpdir(), 'namzu-cancel-')),
			},
			baseConfig(provider),
		)

		// Let the loop reach the (hanging) provider call, then cancel.
		await new Promise((r) => setTimeout(r, 50))
		await agent.cancel()

		const result = await runPromise
		expect(result.status).toBe('cancelled')
	})
})
