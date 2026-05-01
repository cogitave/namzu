/**
 * Phase 2 of ses_001-tool-stream-events removed `chat()` from
 * `LLMProvider`; this suite now exercises the streaming-only wrapper.
 *
 * Invariants under test:
 *   - `wrapProviderWithProbes(provider)` returns an object that
 *     forwards `chatStream` to the inner provider while emitting
 *     `provider_call_start` before iteration and either
 *     `provider_call_completed` (after the iterator drains cleanly,
 *     carrying any aggregated `usage` from the last chunk that
 *     supplied one) or `provider_call_failed` (on a thrown error).
 *   - `callId` is unique per call and correlates start/completed/failed.
 *   - Optional methods (`listModels`, `healthCheck`, `doctorCheck`)
 *     are forwarded when present on the inner provider.
 */

import { describe, expect, it, vi } from 'vitest'

import { buildProbeContext } from '../probe/context.js'
import { createProbeRegistry } from '../probe/registry.js'
import type { AgentBusEvent } from '../types/bus/index.js'
import type { TokenUsage } from '../types/common/index.js'
import type { ChatCompletionParams } from '../types/provider/chat.js'
import type { LLMProvider } from '../types/provider/interface.js'
import type { StreamChunk } from '../types/provider/stream.js'

import { wrapProviderWithProbes } from './instrumentation.js'

const STREAM_USAGE: TokenUsage = {
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

function makeFakeProvider(
	overrides: Partial<{
		chatStream: LLMProvider['chatStream']
	}> = {},
): LLMProvider {
	const defaultStream: LLMProvider['chatStream'] = async function* (
		_params: ChatCompletionParams,
	): AsyncIterable<StreamChunk> {
		yield { id: 'm', delta: { content: 'hi' } }
		yield {
			id: 'm',
			delta: {},
			finishReason: 'stop',
			usage: STREAM_USAGE,
		}
	}
	return {
		id: 'p1',
		name: 'Provider 1',
		chatStream: overrides.chatStream ?? defaultStream,
	}
}

const params: ChatCompletionParams = { model: 'm1', messages: [] } as ChatCompletionParams

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const c of iter) out.push(c)
	return out
}

describe('wrapProviderWithProbes — chatStream', () => {
	it('emits provider_call_start before iteration and provider_call_completed after drain', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), { probes: reg })
		await drain(wrapped.chatStream(params))

		expect(seen.map((e) => e.type)).toEqual(['provider_call_start', 'provider_call_completed'])
		const start = seen[0] as AgentBusEvent & { type: 'provider_call_start' }
		const completed = seen[1] as AgentBusEvent & { type: 'provider_call_completed' }
		expect(start.providerId).toBe('p1')
		expect(start.model).toBe('m1')
		expect(completed.callId).toBe(start.callId)
		expect(completed.durationMs).toBeGreaterThanOrEqual(0)
	})

	it('captures usage from the last chunk that carries it', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), { probes: reg })
		await drain(wrapped.chatStream(params))

		const completed = seen[1] as AgentBusEvent & { type: 'provider_call_completed' }
		expect(completed.usage).toMatchObject({
			inputTokens: STREAM_USAGE.promptTokens,
			outputTokens: STREAM_USAGE.completionTokens,
			totalTokens: STREAM_USAGE.totalTokens,
		})
	})

	it('emits provider_call_failed and re-throws when chatStream throws mid-iteration', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const failing = makeFakeProvider({
			chatStream: async function* () {
				yield { id: 'm', delta: { content: 'partial' } }
				throw new Error('boom')
			},
		})
		const wrapped = wrapProviderWithProbes(failing, { probes: reg })

		await expect(drain(wrapped.chatStream(params))).rejects.toThrow('boom')
		expect(seen.map((e) => e.type)).toEqual(['provider_call_start', 'provider_call_failed'])
		const failed = seen[1] as AgentBusEvent & { type: 'provider_call_failed' }
		expect(failed.error).toBe('boom')
	})

	it('correlates start and completed by callId across multiple calls', async () => {
		const reg = createProbeRegistry()
		const ids: string[] = []
		reg.on('provider_call_start', (event) => ids.push(`s:${event.callId}`))
		reg.on('provider_call_completed', (event) => ids.push(`c:${event.callId}`))

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), { probes: reg })
		await drain(wrapped.chatStream(params))
		await drain(wrapped.chatStream(params))

		expect(ids).toHaveLength(4)
		expect(ids[0]?.split(':')[1]).toBe(ids[1]?.split(':')[1])
		expect(ids[2]?.split(':')[1]).toBe(ids[3]?.split(':')[1])
		expect(ids[0]).not.toBe(ids[2])
	})

	it('forwards optional methods (listModels, healthCheck) to the inner provider', () => {
		const listModels = vi.fn()
		const healthCheck = vi.fn()
		const inner = { ...makeFakeProvider(), listModels, healthCheck }
		const wrapped = wrapProviderWithProbes(inner)

		wrapped.listModels?.()
		wrapped.healthCheck?.()

		expect(listModels).toHaveBeenCalled()
		expect(healthCheck).toHaveBeenCalled()
	})

	it('omits optional methods when inner provider does not declare them', () => {
		const wrapped = wrapProviderWithProbes(makeFakeProvider())
		expect(wrapped.listModels).toBeUndefined()
		expect(wrapped.healthCheck).toBeUndefined()
	})

	it('uses the configured probe context (runId)', async () => {
		const reg = createProbeRegistry()
		const ctx = buildProbeContext({ runId: 'run_42' as `run_${string}` })
		const seen: AgentBusEvent[] = []
		reg.onAny((event, c) => {
			seen.push(event as AgentBusEvent)
			expect(c.runId).toBe(ctx.runId)
		})

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), {
			probes: reg,
			runId: ctx.runId,
		})
		await drain(wrapped.chatStream(params))

		expect(seen.map((e) => e.type)).toEqual(['provider_call_start', 'provider_call_completed'])
	})
})
