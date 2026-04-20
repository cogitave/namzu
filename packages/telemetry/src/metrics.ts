import { getMeter } from './provider.js'

export interface PlatformMetrics {
	recordTokenUsage(model: string, inputTokens: number, outputTokens: number): void
	recordToolCall(toolName: string, success: boolean): void
	recordRunDuration(status: string, durationSec: number): void
	recordLLMLatency(model: string, durationSec: number): void
}

/**
 * Eager-bind platform metrics. Counters and histograms are constructed
 * immediately against whatever `getMeter()` returns.
 *
 * If called before `registerTelemetry(...)`, `getMeter()` returns the
 * `@opentelemetry/api` no-op meter and every subsequent `.add()` / `.record()`
 * call is silently discarded — for the lifetime of this `PlatformMetrics`
 * instance. The no-op bindings are not retroactively rewired when
 * `registerTelemetry` is called later.
 *
 * Call order: `await registerTelemetry({...})` FIRST, then `createPlatformMetrics()`.
 * Or wrap the latter in a lazy factory if the metric bag must be constructed
 * before telemetry registration is guaranteed.
 */
export function createPlatformMetrics(): PlatformMetrics {
	const meter = getMeter()

	const tokenInputCounter = meter.createCounter('gen_ai.client.token.usage', {
		description: 'Number of input (prompt) tokens used',
		unit: '{token}',
	})

	const tokenOutputCounter = meter.createCounter('gen_ai.client.token.usage.output', {
		description: 'Number of output (completion) tokens used',
		unit: '{token}',
	})

	const toolCallCounter = meter.createCounter('gen_ai.tool.call.count', {
		description: 'Number of tool calls executed',
		unit: '{call}',
	})

	const runDurationHistogram = meter.createHistogram('namzu.run.duration', {
		description: 'Agent run duration',
		unit: 's',
	})

	const llmLatencyHistogram = meter.createHistogram('gen_ai.client.operation.duration', {
		description: 'LLM request duration (GenAI semantic convention)',
		unit: 's',
	})

	return {
		recordTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
			tokenInputCounter.add(inputTokens, {
				'gen_ai.request.model': model,
				'gen_ai.token.type': 'input',
			})
			tokenOutputCounter.add(outputTokens, {
				'gen_ai.request.model': model,
				'gen_ai.token.type': 'output',
			})
		},

		recordToolCall(toolName: string, success: boolean): void {
			toolCallCounter.add(1, {
				'gen_ai.tool.name': toolName,
				'namzu.tool.success': success,
			})
		},

		recordRunDuration(status: string, durationSec: number): void {
			runDurationHistogram.record(durationSec, {
				'namzu.run.status': status,
			})
		},

		recordLLMLatency(model: string, durationSec: number): void {
			llmLatencyHistogram.record(durationSec, {
				'gen_ai.request.model': model,
			})
		},
	}
}
