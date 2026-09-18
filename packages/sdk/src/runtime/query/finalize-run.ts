import type { Span } from '@opentelemetry/api'
import { consolidationEntry } from '../../compaction/consolidation.js'
import type { WorkingStateManager } from '../../compaction/manager.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import type { RunEvent, StepResult } from '../../types/run/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { RunContext } from './context.js'
import type { EventTranslator } from './events.js'
import { runOutputGuardrails } from './guardrails.js'
import type { QueryParams } from './index.js'
import { applyLifecycleHookResults } from './plugin-hooks.js'
import type { ResultAssembler } from './result.js'

/**
 * What a run does on its way out, once the loop has stopped.
 *
 * The loop returns for any of a dozen reasons — an answer, a budget, a stop
 * condition, a cancelled signal — and this is the one place all of them pass
 * through: the `run_end`/`subagent_stop` hooks, the step record, the output
 * guardrails, consolidation into a memory store, and the terminal events.
 *
 * It is a generator because it emits, and it is reached with `yield*` so
 * every one of those emits suspends the caller at exactly the point it did
 * when the code lived inline.
 *
 * Two positions here are load-bearing, and they are stated where they happen.
 * `markCancelled` runs before the assembler, because `completeRun` marks a
 * `running` run `completed` — the reverse order would overwrite the
 * cancellation the abort signal had already declared. And
 * `memory_consolidated` precedes `run_completed`, so a host folding the
 * stream in order has the memory before the run that produced it.
 *
 * `setSteps` keeps its position too, but on the move's terms rather than on
 * its own. This file used to claim the assembler needed it first "or the
 * returned `Run` loses the final turn's steps" — that is not true, and a
 * mutation proves it: `completeRun` reads `result`, `stopReason` and the
 * budget and never `steps`, the returned `Run` is built by `finalize()`
 * (which runs after the whole `try`/`catch`/`finally`), and moving
 * `setSteps` below the assembler leaves the suite green, including the test
 * that asserts `run.steps` on a returned run. What holds `setSteps` where it
 * is, is the byte-identity of this move: every position was preserved, not
 * just the consequential ones. Its read is still deferred to the same
 * moment — after the `run_end` hooks, immediately before the record is
 * written — which is why the caller passes `takeSteps` rather than an array.
 */
export interface RunFinalization {
	readonly ctx: RunContext
	readonly params: QueryParams
	readonly eventTranslator: EventTranslator
	/**
	 * The steps the loop recorded, read HERE rather than handed over as an
	 * array: it is read where it always was, after the `run_end` hooks and
	 * immediately before the record is written.
	 */
	readonly takeSteps: () => readonly StepResult[]
	readonly workingStateManager: WorkingStateManager | undefined
	readonly resultAssembler: ResultAssembler
	readonly rootSpan: Span
}

export async function* finalizeRun(finalization: RunFinalization): AsyncGenerator<RunEvent, void> {
	const {
		ctx,
		params,
		eventTranslator,
		takeSteps,
		workingStateManager,
		resultAssembler,
		rootSpan,
	} = finalization

	if (params.pluginManager) {
		const hookResults = await params.pluginManager.executeHooks(
			'run_end',
			{ runId: ctx.runId, signal: ctx.abortController.signal },
			eventTranslator.emitEvent,
		)
		applyLifecycleHookResults('run_end', hookResults)
		yield* eventTranslator.drainPending()
		// A delegated run says so once more, by name, so a hook that
		// only cares when a subagent finishes need not read parent ids
		// off every run_end.
		if (params.parentRunId !== undefined) {
			const stopResults = await params.pluginManager.executeHooks(
				'subagent_stop',
				{
					runId: ctx.runId,
					parentRunId: params.parentRunId,
					signal: ctx.abortController.signal,
				},
				eventTranslator.emitEvent,
			)
			applyLifecycleHookResults('subagent_stop', stopResults)
			yield* eventTranslator.drainPending()
		}
	}

	// Hand the step record to the run before it settles, so the
	// returned `Run` carries it.
	ctx.runMgr.setSteps(takeSteps())

	// Gates the FINAL result, not the stream — `text_delta` already
	// reached the host as the model produced it. A rewrite is
	// therefore a correction, and the event says so; buffering every
	// token to gate the stream itself would trade the streaming UX
	// for the guarantee, which is the host's call, not the SDK's.
	if (params.outputGuardrails && params.outputGuardrails.length > 0) {
		// Read what the run produced WITHOUT settling it. This used to
		// call `markCompleted()` just to materialize the text, which
		// force-marked a cancelled or paused run `completed` merely
		// because a guardrail was configured — the presence of a
		// safety check silently rewrote the run's own outcome.
		const produced = ctx.runMgr.materializeResult()
		const outputVerdict = await runOutputGuardrails(
			params.outputGuardrails,
			{ runId: ctx.runId, output: produced, messages: ctx.runMgr.messages },
			ctx.log,
		)

		if (outputVerdict.blocked || outputVerdict.rewritten !== undefined) {
			ctx.runMgr.clearStructuredOutput()
			if (
				params.structuredOutput &&
				outputVerdict.rewritten !== undefined &&
				ctx.runMgr.stopReason === 'end_turn'
			)
				ctx.runMgr.setStopReason('output_guardrail')
		}

		if (outputVerdict.blocked) {
			await eventTranslator.emitEvent({
				type: 'guardrail_triggered',
				runId: ctx.runId,
				stage: 'output',
				action: 'block',
				...(outputVerdict.name ? { guardrail: outputVerdict.name } : {}),
				...(outputVerdict.reason ? { reason: outputVerdict.reason } : {}),
			})
			yield* eventTranslator.drainPending()
			// Same reasoning as the input-guardrail branch above.
			await ctx.runMgr.recordAudit({
				what: { action: 'guardrail:output', resource: outputVerdict.name },
				outcome: 'refused',
				reason: outputVerdict.reason ?? 'blocked by an output guardrail',
				...(params.persona?.identity.role ? { persona: params.persona.identity.role } : {}),
			})
			ctx.runMgr.setStopReason('output_guardrail')
			ctx.runMgr.setLastError(outputVerdict.reason ?? 'blocked by an output guardrail')
			ctx.runMgr.setResult('')
		} else if (outputVerdict.rewritten !== undefined) {
			await eventTranslator.emitEvent({
				type: 'guardrail_triggered',
				runId: ctx.runId,
				stage: 'output',
				action: 'rewrite',
				...(outputVerdict.name ? { guardrail: outputVerdict.name } : {}),
				...(outputVerdict.reason ? { reason: outputVerdict.reason } : {}),
			})
			yield* eventTranslator.drainPending()
			ctx.runMgr.setResult(outputVerdict.rewritten)
		}
	}

	if (params.consolidateInto && workingStateManager) {
		const entry = consolidationEntry(workingStateManager.getState(), {
			runId: ctx.runId,
			at: Date.now(),
		})
		if (entry) {
			try {
				const { entry: saved } = await params.consolidateInto.create(entry)
				await eventTranslator.emitEvent({
					type: 'memory_consolidated',
					runId: ctx.runId,
					memoryId: saved.id,
					title: entry.title,
					decisions: workingStateManager.getState().decisions.length,
					discoveries: workingStateManager.getState().discoveries.length,
					failures: workingStateManager.getState().failures.length,
				})
				yield* eventTranslator.drainPending()
			} catch (error) {
				ctx.log.warn('consolidation into the memory store failed', {
					[NAMZU.RUN_ID]: ctx.runId,
					'namzu.memory.error': toErrorMessage(error),
				})
			}
		}
	}
	if (ctx.abortController.signal.aborted) ctx.runMgr.markCancelled()
	yield* resultAssembler.completeRun(rootSpan)
}
