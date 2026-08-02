import {
	recordModelDuration,
	recordRunDuration as recordRunDurationMs,
	recordTokenUsage as recordTokenUsageSample,
	recordToolCall as recordToolCallOutcome,
} from '@namzu/sdk'

export interface PlatformMetrics {
	recordTokenUsage(model: string, inputTokens: number, outputTokens: number): void
	recordToolCall(toolName: string, success: boolean): void
	recordRunDuration(status: string, durationSec: number): void
	recordLLMLatency(model: string, durationSec: number): void
}

/**
 * A host-facing handle onto the runtime's own metric instruments.
 *
 * This used to define its own counters and histograms, which had two
 * consequences and no benefit. The instruments were bound EAGERLY, so a bag
 * built before `registerTelemetry()` captured the no-op meter and discarded
 * every write for the rest of its life — silently, forever, from one line
 * of call order. And nothing in the workspace ever built one, so the
 * runtime emitted spans and not a single measurement.
 *
 * The instruments now live beside the code that records them, and this
 * delegates. Call order no longer matters: they resolve on first use and
 * re-resolve once a real provider is installed. Anything a host records
 * here lands on the same series as the runtime's own, so the two aggregate
 * instead of describing the same events under two names.
 */
export function createPlatformMetrics(): PlatformMetrics {
	return {
		recordTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
			recordTokenUsageSample(model, {
				promptTokens: inputTokens,
				completionTokens: outputTokens,
			})
		},

		recordToolCall(toolName: string, success: boolean): void {
			recordToolCallOutcome(toolName, success)
		},

		// This signature takes seconds and the recorder takes milliseconds.
		// The conversion has to happen on exactly one side of the boundary;
		// it lives on the recorder's, so this undoes it rather than letting
		// both sides divide.
		recordRunDuration(status: string, durationSec: number): void {
			recordRunDurationMs(status, durationSec * 1000)
		},

		recordLLMLatency(model: string, durationSec: number): void {
			recordModelDuration(model, durationSec * 1000)
		},
	}
}
