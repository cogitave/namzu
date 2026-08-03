import type { Run } from '../types/run/entity.js'
import type { EvalRun } from './types.js'

/**
 * Project a finished `Run` into the shape scorers consume.
 *
 * This is the whole bridge between the harness and the runtime, and it is
 * three lines of mapping because `Run.steps` now exists. Before that, a
 * trajectory scorer would have had to correlate raw `RunEvent`s by
 * iteration number and diff cumulative counters — which is why the step
 * record had to land before the harness could.
 */
export function evalRunFromRun(run: Run, opts: { durationMs?: number } = {}): EvalRun {
	const steps = run.steps ?? []
	return {
		output: run.result ?? null,
		...(run.structuredOutput !== undefined ? { structuredOutput: run.structuredOutput } : {}),
		steps,
		// Flattened in call order across steps — the trajectory.
		toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => c.function.name)),
		...(run.stopReason ? { stopReason: run.stopReason } : {}),
		totalTokens: run.tokenUsage.totalTokens,
		totalCostUsd: run.costInfo.totalCost,
		durationMs: opts.durationMs ?? (run.endedAt ?? Date.now()) - run.startedAt,
		...(run.lastError ? { error: run.lastError } : {}),
	}
}

/**
 * Drain a `query()` generator to its returned `Run`, then project it.
 *
 * The common case, so it does not need writing per suite:
 *
 * ```ts
 * runExperiment({
 *   name: 'file-editing',
 *   cases,
 *   scorers: [trajectoryScorer(), completionScorer()],
 *   run: (input) => evalRunFromQuery(query({ provider, tools, messages: input, … })),
 * })
 * ```
 */
export async function evalRunFromQuery(generator: AsyncGenerator<unknown, Run>): Promise<EvalRun> {
	const startedAt = Date.now()
	let next = await generator.next()
	while (!next.done) next = await generator.next()
	return evalRunFromRun(next.value, { durationMs: Date.now() - startedAt })
}
