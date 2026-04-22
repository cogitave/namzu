import { describe, expect, it, vi } from 'vitest'

import { buildProbeContext } from '../probe/context.js'
import { createProbeRegistry } from '../probe/registry.js'
import type { AgentBusEvent } from '../types/bus/index.js'
import type { ChatCompletionParams, ChatCompletionResponse } from '../types/provider/chat.js'
import type { LLMProvider } from '../types/provider/interface.js'
import type { StreamChunk } from '../types/provider/stream.js'

import { wrapProviderWithProbes } from './instrumentation.js'

function makeFakeProvider(
	overrides: Partial<{
		chat: LLMProvider['chat']
		chatStream: LLMProvider['chatStream']
	}> = {},
): LLMProvider {
	const defaultChat: LLMProvider['chat'] = async (
		_params: ChatCompletionParams,
	): Promise<ChatCompletionResponse> => {
		return {
			content: 'ok',
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		} as unknown as ChatCompletionResponse
	}
	const defaultStream: LLMProvider['chatStream'] = async function* (
		_params: ChatCompletionParams,
	): AsyncIterable<StreamChunk> {
		yield { delta: 'hi' } as unknown as StreamChunk
	}
	return {
		id: 'p1',
		name: 'Provider 1',
		chat: overrides.chat ?? defaultChat,
		chatStream: overrides.chatStream ?? defaultStream,
	}
}

const params: ChatCompletionParams = { model: 'm1', messages: [] } as ChatCompletionParams

describe('wrapProviderWithProbes — chat', () => {
	it('emits provider_call_start before the chat call and provider_call_completed after', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), { probes: reg })
		await wrapped.chat(params)

		expect(seen.map((e) => e.type)).toEqual(['provider_call_start', 'provider_call_completed'])
		const start = seen[0] as AgentBusEvent & { type: 'provider_call_start' }
		const completed = seen[1] as AgentBusEvent & { type: 'provider_call_completed' }
		expect(start.providerId).toBe('p1')
		expect(start.model).toBe('m1')
		expect(completed.callId).toBe(start.callId)
		expect(completed.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
		expect(completed.durationMs).toBeGreaterThanOrEqual(0)
	})

	it('emits provider_call_failed and re-throws when chat throws', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const failing = makeFakeProvider({
			chat: async () => {
				throw new Error('boom')
			},
		})
		const wrapped = wrapProviderWithProbes(failing, { probes: reg })

		await expect(wrapped.chat(params)).rejects.toThrow('boom')
		expect(seen.map((e) => e.type)).toEqual(['provider_call_start', 'provider_call_failed'])
		const failed = seen[1] as AgentBusEvent & { type: 'provider_call_failed' }
		expect(failed.error).toBe('boom')
	})

	it('correlates start and completed by callId', async () => {
		const reg = createProbeRegistry()
		const ids: string[] = []
		reg.on('provider_call_start', (event) => ids.push(`s:${event.callId}`))
		reg.on('provider_call_completed', (event) => ids.push(`c:${event.callId}`))

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), { probes: reg })
		await wrapped.chat(params)
		await wrapped.chat(params)

		expect(ids.length).toBe(4)
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
		expect(listModels).toHaveBeenCalledTimes(1)
		expect(healthCheck).toHaveBeenCalledTimes(1)
	})
})

describe('wrapProviderWithProbes — chatStream', () => {
	it('emits provider_call_start before iteration and provider_call_completed after', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), { probes: reg })
		const chunks: StreamChunk[] = []
		for await (const chunk of wrapped.chatStream(params)) {
			chunks.push(chunk)
		}

		expect(chunks.length).toBe(1)
		expect(seen.map((e) => e.type)).toEqual(['provider_call_start', 'provider_call_completed'])
	})

	it('emits provider_call_failed when the underlying stream throws mid-iteration', async () => {
		const reg = createProbeRegistry()
		const seen: AgentBusEvent[] = []
		reg.onAny((event) => seen.push(event as AgentBusEvent))

		const failing = makeFakeProvider({
			chatStream: async function* (_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				yield { delta: 'a' } as unknown as StreamChunk
				throw new Error('stream-boom')
			},
		})
		const wrapped = wrapProviderWithProbes(failing, { probes: reg })

		await expect(async () => {
			for await (const _chunk of wrapped.chatStream(params)) {
				// noop
			}
		}).rejects.toThrow('stream-boom')

		expect(seen.map((e) => e.type)).toEqual(['provider_call_start', 'provider_call_failed'])
	})
})

describe('wrapProviderWithProbes — runId propagation', () => {
	it('attaches runId to each emitted event when supplied', async () => {
		const reg = createProbeRegistry()
		let observedRunId: string | undefined
		reg.on('provider_call_start', (event, ctx) => {
			observedRunId = event.runId ?? ctx.runId
		})

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), {
			probes: reg,
			runId: 'run_42' as never,
		})
		await wrapped.chat(params)
		expect(observedRunId).toBe('run_42')
	})
})

describe('wrapProviderWithProbes — uses singleton when no probes opt provided', () => {
	it('still wraps successfully without throwing (smoke)', async () => {
		// Use a fresh inner provider; we just want to verify the default path
		// instantiates and runs. Singleton dispatch is exercised in registry tests.
		const wrapped = wrapProviderWithProbes(makeFakeProvider())
		await expect(wrapped.chat(params)).resolves.toBeDefined()
	})
})

describe('wrapProviderWithProbes — context still flows through buildProbeContext', () => {
	it('handler receives a frozen ctx', async () => {
		const reg = createProbeRegistry()
		let captured: Readonly<{ isReplay: boolean }> | undefined
		reg.on('provider_call_start', (_event, ctx) => {
			captured = ctx
		})

		const wrapped = wrapProviderWithProbes(makeFakeProvider(), { probes: reg })
		await wrapped.chat(params)
		expect(captured).toBeDefined()
		expect(Object.isFrozen(captured)).toBe(true)
		expect(captured?.isReplay).toBe(false)
	})

	it('buildProbeContext used internally returns a frozen ProbeContext (sanity check)', () => {
		const ctx = buildProbeContext({ isReplay: true })
		expect(ctx.isReplay).toBe(true)
		expect(Object.isFrozen(ctx)).toBe(true)
	})
})
