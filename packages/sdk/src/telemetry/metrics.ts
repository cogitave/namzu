import { type Counter, type Histogram, type Meter, metrics } from '@opentelemetry/api'
import { GENAI, NAMZU } from '../constants/telemetry/index.js'

/**
 * The runtime's metric instruments.
 *
 * Metrics lived in the telemetry package as a bag a host constructed for
 * itself — and nothing in the workspace ever constructed one, so the
 * runtime emitted spans and not a single measurement. Defining them beside
 * the code that records them is what stops that recurring: an instrument
 * with no call site is visible here, where a bag with no owner was not.
 *
 * Every instrument is resolved LAZILY. Binding eagerly meant that a bag
 * built before `registerTelemetry()` captured the no-op meter and threw
 * every write away for the rest of its life — silently, and forever, from
 * one line of call-order. Ordering is not something a caller should have
 * to get right to be measured at all.
 */

let cached: { meter: Meter; instruments: Instruments } | undefined

interface Instruments {
	tokens: Counter
	toolCalls: Counter
	runDuration: Histogram
	llmDuration: Histogram
	timeToFirstToken: Histogram
	toolDuration: Histogram
}

function build(meter: Meter): Instruments {
	return {
		// ONE counter for every token, split by `gen_ai.token.type`. It was
		// two counters under two names, the second of them invented — so a
		// dashboard aggregating the conventional name got input tokens only
		// and under-reported usage by roughly half, with nothing to suggest
		// the other half existed.
		tokens: meter.createCounter('gen_ai.client.token.usage', {
			description: 'Tokens used, by type',
			unit: '{token}',
		}),
		toolCalls: meter.createCounter('gen_ai.tool.call.count', {
			description: 'Tool calls executed',
			unit: '{call}',
		}),
		runDuration: meter.createHistogram('namzu.run.duration', {
			description: 'Agent run duration',
			unit: 's',
		}),
		llmDuration: meter.createHistogram('gen_ai.client.operation.duration', {
			description: 'Model request duration',
			unit: 's',
		}),
		// namzu streams, so perceived latency is dominated by how long the
		// user waits for the FIRST token, not by how long the whole request
		// takes. The request histogram above cannot tell a fast-first-token
		// long generation from a stalled one, and no host could recover the
		// distinction from namzu's data in any form.
		timeToFirstToken: meter.createHistogram('gen_ai.client.time_to_first_token', {
			description: 'Time from request start to the first content delta',
			unit: 's',
		}),
		// The wall clock was measured since the first version of the executor
		// and emitted per call on `tool_completed`, so a p95 was computable
		// from events — but there was no instrument, with the value already
		// in scope one frame above the call site.
		toolDuration: meter.createHistogram('gen_ai.tool.call.duration', {
			description: 'Tool execution duration',
			unit: 's',
		}),
	}
}

/**
 * Resolve instruments against the meter that is live *now*.
 *
 * Cached against the meter identity rather than unconditionally: rebuilding
 * on every call would allocate on a hot path, and never rebuilding is the
 * bug this replaces. When `registerTelemetry()` swaps the global provider
 * the meter changes, the cache misses once, and everything after that is
 * recorded through the real one.
 */
function instruments(): Instruments {
	const meter = metrics.getMeter('namzu')
	if (cached?.meter === meter) return cached.instruments
	const built = build(meter)
	cached = { meter, instruments: built }
	return built
}

/** Drop the cache. Tests that swap the global provider need this. */
export function resetRuntimeMetrics(): void {
	cached = undefined
}

export interface TokenUsageSample {
	readonly promptTokens: number
	readonly completionTokens: number
	/** Prompt tokens served from the provider's cache. */
	readonly cachedTokens?: number
	/** Prompt tokens written into the provider's cache. */
	readonly cacheWriteTokens?: number
}

/**
 * Record what a turn cost, split by token type.
 *
 * Cache reads and writes are recorded as their own types rather than
 * folded into `input`. They bill differently — a read is a fraction of the
 * input rate and a write is a premium on it — so a total that hides them
 * cannot explain a bill, which is the main thing anyone asks a token
 * metric.
 */
export function recordTokenUsage(model: string, usage: TokenUsageSample): void {
	const { tokens } = instruments()
	if (usage.promptTokens > 0) {
		tokens.add(usage.promptTokens, {
			[GENAI.REQUEST_MODEL]: model,
			[GENAI.TOKEN_TYPE]: 'input',
		})
	}
	if (usage.completionTokens > 0) {
		tokens.add(usage.completionTokens, {
			[GENAI.REQUEST_MODEL]: model,
			[GENAI.TOKEN_TYPE]: 'output',
		})
	}
	if (usage.cachedTokens !== undefined && usage.cachedTokens > 0) {
		tokens.add(usage.cachedTokens, {
			[GENAI.REQUEST_MODEL]: model,
			[GENAI.TOKEN_TYPE]: 'cache_read',
		})
	}
	if (usage.cacheWriteTokens !== undefined && usage.cacheWriteTokens > 0) {
		tokens.add(usage.cacheWriteTokens, {
			[GENAI.REQUEST_MODEL]: model,
			[GENAI.TOKEN_TYPE]: 'cache_write',
		})
	}
}

/**
 * Record a tool call.
 *
 * `errorType` carries WHY a call failed rather than only that it did. A
 * flat success rate cannot separate a tool that is broken from one whose
 * input the model keeps getting wrong, and those need different fixes.
 */
export function recordToolCall(
	toolName: string,
	success: boolean,
	errorType?: string,
	durationMs?: number,
): void {
	const attributes = {
		[GENAI.TOOL_NAME]: toolName,
		[NAMZU.TOOL_SUCCESS]: success,
		...(errorType !== undefined ? { [NAMZU.TOOL_ERROR]: errorType } : {}),
	}
	const { toolCalls, toolDuration } = instruments()
	toolCalls.add(1, attributes)
	// Same attributes as the count, so "which tool is slow" and "which tool
	// fails" are answerable from one query rather than two that cannot be
	// joined.
	if (durationMs !== undefined) toolDuration.record(durationMs / 1000, attributes)
}

/**
 * Record how long the first content delta took to arrive.
 *
 * Recorded at the first delta rather than at the end of the request,
 * because the two are not the same measurement and only this one tracks
 * what a person waiting actually experiences.
 */
export function recordTimeToFirstToken(model: string, durationMs: number): void {
	instruments().timeToFirstToken.record(durationMs / 1000, { [GENAI.REQUEST_MODEL]: model })
}

/** Record how long a whole run took, keyed by how it settled. */
export function recordRunDuration(status: string, durationMs: number): void {
	instruments().runDuration.record(durationMs / 1000, { [NAMZU.RUN_STATUS]: status })
}

/** Record how long one model request took. */
export function recordModelDuration(model: string, durationMs: number, errorType?: string): void {
	instruments().llmDuration.record(durationMs / 1000, {
		[GENAI.REQUEST_MODEL]: model,
		...(errorType !== undefined ? { [NAMZU.TOOL_ERROR]: errorType } : {}),
	})
}
