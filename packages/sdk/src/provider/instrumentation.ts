import { buildProbeContext } from '../probe/context.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../probe/registry.js'
import type { ProviderCallId, ProviderCallUsage } from '../types/bus/index.js'
import type { TokenUsage } from '../types/common/index.js'
import type { RunId } from '../types/ids/index.js'
import type { ChatCompletionParams } from '../types/provider/chat.js'
import type { LLMProvider } from '../types/provider/interface.js'
import type { StreamChunk } from '../types/provider/stream.js'

export interface ProviderInstrumentationOptions {
	readonly probes?: ProbeRegistry
	readonly runId?: RunId
}

let providerCallCounter = 0

function nextCallId(): ProviderCallId {
	providerCallCounter += 1
	return `pcall_${Date.now().toString(36)}${providerCallCounter.toString(36)}` as ProviderCallId
}

function extractStreamUsage(usage: TokenUsage | undefined): ProviderCallUsage | undefined {
	if (!usage) return undefined
	const u = usage as TokenUsage & Partial<ProviderCallUsage>
	return {
		inputTokens: u.inputTokens ?? u.promptTokens,
		outputTokens: u.outputTokens ?? u.completionTokens,
		totalTokens: u.totalTokens,
		costUsd: u.costUsd,
	}
}

export function wrapProviderWithProbes(
	provider: LLMProvider,
	opts: ProviderInstrumentationOptions = {},
): LLMProvider {
	const probes = opts.probes ?? defaultProbeRegistry
	const runId = opts.runId

	const wrapped: LLMProvider = {
		id: provider.id,
		name: provider.name,
		listModels: provider.listModels?.bind(provider),
		healthCheck: provider.healthCheck?.bind(provider),

		async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			const callId = nextCallId()
			const ctx = buildProbeContext({ runId })
			const startedAt = Date.now()
			probes.dispatch(
				{
					type: 'provider_call_start',
					providerId: provider.id,
					model: params.model,
					callId,
					runId,
				},
				ctx,
			)
			try {
				let lastUsage: TokenUsage | undefined
				for await (const chunk of provider.chatStream(params)) {
					if (chunk.usage) lastUsage = chunk.usage
					yield chunk
				}
				probes.dispatch(
					{
						type: 'provider_call_completed',
						providerId: provider.id,
						model: params.model,
						callId,
						runId,
						durationMs: Date.now() - startedAt,
						usage: extractStreamUsage(lastUsage),
					},
					ctx,
				)
			} catch (error) {
				probes.dispatch(
					{
						type: 'provider_call_failed',
						providerId: provider.id,
						model: params.model,
						callId,
						runId,
						durationMs: Date.now() - startedAt,
						error: error instanceof Error ? error.message : String(error),
					},
					ctx,
				)
				throw error
			}
		},
	}

	return wrapped
}
