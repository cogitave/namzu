import type { Turn } from '../types/session/turn.js'
import type { EvalTurn } from './types.js'

/**
 * Project a finished `Turn` into the shape scorers consume.
 *
 * This is the whole bridge between the harness and the runtime, and it is
 * three lines of mapping because `Turn.steps` exists. Before that, a
 * trajectory scorer would have had to correlate raw `SessionEvent`s by
 * iteration number and diff cumulative counters — which is why the step
 * record had to land before the harness could.
 */
export function evalTurnFromTurn(turn: Turn, opts: { durationMs?: number } = {}): EvalTurn {
	const steps = turn.steps ?? []
	return {
		output: turn.result ?? null,
		...(turn.structuredOutput !== undefined ? { structuredOutput: turn.structuredOutput } : {}),
		steps,
		// Flattened in call order across steps — the trajectory.
		toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => c.function.name)),
		...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
		totalTokens: turn.tokenUsage.totalTokens,
		totalCostUsd: turn.costInfo.totalCost,
		durationMs: opts.durationMs ?? (turn.endedAt ?? Date.now()) - turn.startedAt,
		...(turn.lastError ? { error: turn.lastError } : {}),
	}
}

/**
 * Drain a `query()` generator to its returned `Turn`, then project it.
 *
 * The common case, so it does not need writing per suite:
 *
 * ```ts
 * runExperiment({
 *   name: 'file-editing',
 *   cases,
 *   scorers: [trajectoryScorer(), completionScorer()],
 *   run: (input) => evalTurnFromQuery(query({ provider, tools, messages: input, … })),
 * })
 * ```
 */
export async function evalTurnFromQuery(
	generator: AsyncGenerator<unknown, Turn>,
): Promise<EvalTurn> {
	const startedAt = Date.now()
	let next = await generator.next()
	while (!next.done) next = await generator.next()
	return evalTurnFromTurn(next.value, { durationMs: Date.now() - startedAt })
}
