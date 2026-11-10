/**
 * Through `query()`: a chain member that keeps answering "overloaded" is left
 * after three answers by default, `overloadedFallOverAfter: 0` keeps the whole
 * retry budget, and the last member of a chain is never cut short. The waits
 * are one millisecond; no outcome here depends on how long they take.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { failingStream } from '../../../__fixtures__/failing-stream.js'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

function overloaded(id: string): LLMProvider & { calls: number } {
	let calls = 0
	return {
		id,
		name: id,
		chatStream: (): AsyncIterable<StreamChunk> => {
			calls++
			return failingStream(Object.assign(new Error('HTTP 529'), { status: 529 }))
		},
		get calls() {
			return calls
		},
	} as unknown as LLMProvider & { calls: number }
}

describe('repeated overload through query()', () => {
	let dirs: string[] = []
	afterEach(async () => {
		await removeTempDirs(dirs)
		dirs = []
	})

	async function run(
		primary: LLMProvider,
		fallbacks: LLMProvider[],
		retry: { overloadedFallOverAfter?: number },
	) {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-overload-'))
		dirs.push(dir)
		return drainQuery({
			toolsets: [],
			turnConfig: {
				model: 'primary-model',
				timeoutMs: 5_000,
				// 0 is no limit. A finite budget treats a 5xx without usage as unresolved spend
				// and refuses the next request, which is a different path from the one under test.
				tokenBudget: 0,
				maxIterations: 1,
				maxResponseTokens: 256,
			},
			agentId: 'agent_overload',
			agentName: 'Overload Agent',
			workingDirectory: dir,
			sessionId: '5b8e8c24-cb10-41a5-8ae5-7e3aaab9dd4b' as SessionId,
			topicId: 'ca587325-12f2-4907-9f09-69d34e083baa' as TopicId,
			projectId: '5672b541-0670-44c5-a06d-bceceb884aed' as ProjectId,
			tenantId: '4f69727d-8832-4d1b-85ec-b928d4d3e576' as TenantId,
			retry: { maxRetries: 10, initialDelayMs: 1, maxDelayMs: 1, ...retry },
			provider: primary,
			fallbackProviders: fallbacks.map((provider) => ({ provider, model: 'second-model' })),
			messages: [createUserMessage('hello')],
		})
	}

	it('leaves the saturated head after 3 attempts by default', async () => {
		const head = overloaded('head')
		const second = new MockLLMProvider({ turns: [{ text: 'second answered' }] })
		const result = await run(head, [second], {})
		expect(result.status).toBe('completed')
		expect(head.calls).toBe(3)
	})

	it('keeps the whole budget (11 attempts) when the option is 0', async () => {
		const head = overloaded('head')
		const second = new MockLLMProvider({ turns: [{ text: 'second answered' }] })
		const result = await run(head, [second], { overloadedFallOverAfter: 0 })
		expect(result.status).toBe('completed')
		expect(head.calls).toBe(11)
	})

	it('never cuts the last member short', async () => {
		const head = overloaded('head')
		const last = overloaded('last')
		await run(head, [last], {})
		expect(head.calls).toBe(3)
		expect(last.calls).toBe(11)
	})
})
