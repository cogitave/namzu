import { type Span, SpanStatusCode } from '@opentelemetry/api'
import { extractFromAssistantMessage } from '../../../compaction/extractor.js'
import { AUTO_CONTINUATION_USER_MESSAGE } from '../../../constants/continuation.js'
import { collect } from '../../../provider/collect.js'
import {
	GENAI,
	NAMZU,
	agentIterationSpanName,
	parentContext,
} from '../../../telemetry/attributes.js'
import { getTracer } from '../../../telemetry/runtime-accessors.js'
import type { CostInfo, TokenUsage } from '../../../types/common/index.js'
import type { MessageId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent, StepResult, StopReason } from '../../../types/run/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import { generateMessageId } from '../../../utils/id.js'
import type { ToolCallOutcome } from '../executor.js'
import { applyLifecycleHookResults } from '../plugin-hooks.js'
import { runAdvisoryPhase } from './phases/advisory.js'
import { runIterationCheckpoint } from './phases/checkpoint.js'
import { runCompactionCheck } from './phases/compaction.js'
import type { IterationContext } from './phases/index.js'
import { runPlanGate } from './phases/plan.js'
import { runToolReview } from './phases/tool-review.js'
import { refreshWorkingMemory } from './phases/working-memory.js'
import { streamProviderTurn } from './stream-turn.js'

export type { IterationContext } from './phases/index.js'
export type { PhaseSignal } from './phases/index.js'
export type { ToolReviewOutcome } from './phases/index.js'

export class IterationOrchestrator {
	private ctx: IterationContext

	constructor(ctx: IterationContext) {
		this.ctx = ctx
	}

	/**
	 * Adopt the run's span after construction.
	 *
	 * The orchestrator is built before `query()` enters its generator body,
	 * which is where the run span is created — so the parent cannot be a
	 * constructor argument without reordering setup around one field.
	 */
	setRootSpan(span: Span): void {
		this.ctx = { ...this.ctx, rootSpan: span }
	}

	async *runLoop(): AsyncGenerator<RunEvent> {
		const { runConfig, runMgr } = this.ctx
		const { model } = runConfig
		const tracer = getTracer()

		const planSignal = yield* runPlanGate(this.ctx)
		if (planSignal === 'stop') return

		while (true) {
			const guardResult = this.ctx.guard.beforeIteration(runMgr, this.ctx.abortController.signal)

			if (guardResult.shouldStop) {
				if (guardResult.isCancelled) {
					this.ctx.log.info('Run cancelled by signal', { runId: runMgr.id })
					runMgr.setStopReason('cancelled')
					runMgr.markCancelled()
					break
				}

				const stopReason = guardResult.stopReason ?? 'end_turn'
				this.ctx.log.info('Guard enforcing stop', {
					runId: runMgr.id,
					stopReason,
					iteration: runMgr.currentIteration,
					inputTokens: runMgr.tokenUsage.promptTokens,
					outputTokens: runMgr.tokenUsage.completionTokens,
				})
				await this.requestFinalResponse(model, stopReason)
				yield* this.ctx.drainPending()
				runMgr.setStopReason(stopReason)
				break
			}

			const forceFinalize = guardResult.forceFinalize
			const iterationNum = runMgr.incrementIteration()
			this.ctx.log.debug('Iteration started', {
				runId: runMgr.id,
				iteration: iterationNum,
				model,
				forceFinalize,
				messageCount: runMgr.messages.length,
			})

			const iterationActivity = this.ctx.activityStore.create({
				type: 'llm_turn',
				description: `LLM iteration ${iterationNum}`,
			})
			if (iterationActivity) {
				this.ctx.activityStore.start(iterationActivity.id)
			}

			// Parent explicitly: this body is an async generator, so the
			// ambient context at resume time belongs to the CONSUMER, not to
			// whoever created the run span. Without this every iteration
			// emits as its own root and a 20-turn run shows up as 21
			// disconnected traces.
			const iterSpan = tracer.startSpan(
				agentIterationSpanName(iterationNum),
				{},
				parentContext(this.ctx.rootSpan),
			)
			// Tool spans for this turn belong under this iteration.
			this.ctx.toolExecutor.setParentSpan(iterSpan)

			iterSpan.setAttributes({
				[NAMZU.ITERATION]: iterationNum,
				[NAMZU.RUN_ID]: runMgr.id,
				[GENAI.REQUEST_MODEL]: model,
			})

			await this.ctx.emitEvent({
				type: 'iteration_started',
				runId: runMgr.id,
				iteration: iterationNum,
			})
			yield* this.ctx.drainPending()

			try {
				if (this.ctx.pluginManager) {
					const hookResults = await this.ctx.pluginManager.executeHooks(
						'iteration_start',
						{ runId: runMgr.id, iteration: iterationNum },
						this.ctx.emitEvent,
					)
					applyLifecycleHookResults('iteration_start', hookResults)
					yield* this.ctx.drainPending()
				}

				// Re-pin the working-memory block from ground truth at the primacy
				// edge BEFORE compaction runs (so the refreshed slot is what
				// compaction preserves). No-op when no provider is configured.
				await refreshWorkingMemory(this.ctx)
				await runCompactionCheck(this.ctx)

				// Cache discipline: keep the tools param byte-stable even on the
				// forced-final iteration and forbid tool use via tool_choice
				// 'none' instead. Dropping the tools array would invalidate the
				// entire prompt-cache prefix (tools render at position 0) and
				// risks a 400 because the history still carries
				// tool_use/tool_result blocks.
				// Snapshot the cumulative counters so the step can report ITS
				// own usage rather than the run total.
				const stepStartedAt = Date.now()
				const usageBefore = { ...runMgr.tokenUsage }
				const costBefore = { ...runMgr.costInfo }

				const openAITools = this.ctx.tools.toLLMTools(this.ctx.allowedTools)

				const messages = forceFinalize
					? [
							...runMgr.messages,
							createUserMessage(
								'[SYSTEM] You are approaching your resource limits. Provide your final, comprehensive response now based on everything you have gathered so far. Do not request any more tool calls.',
							),
						]
					: runMgr.messages

				if (this.ctx.pluginManager) {
					const hookResults = await this.ctx.pluginManager.executeHooks(
						'pre_llm_call',
						{ runId: runMgr.id, iteration: iterationNum },
						this.ctx.emitEvent,
					)
					applyLifecycleHookResults('pre_llm_call', hookResults)
					yield* this.ctx.drainPending()
				}

				// Phase 4 (ses_001-tool-stream-events): consume the
				// streaming response natively, emitting message and
				// tool-input lifecycle events as deltas arrive. The
				// helper yields RunEvents through drainPending() so SSE
				// consumers see live progress; its return value is the
				// aggregated `ChatCompletionResponse` for the legacy
				// downstream paths (assistantMsg construction, working
				// state extraction, telemetry attribute stamping).
				const { response, messageId } = yield* streamProviderTurn(
					this.ctx.provider,
					{
						model,
						messages,
						tools: openAITools.length > 0 ? openAITools : undefined,
						toolChoice: forceFinalize && openAITools.length > 0 ? 'none' : undefined,
						temperature: runConfig.temperature,
						maxTokens: runConfig.maxResponseTokens,
						cacheControl: { type: 'auto' },
						...(runConfig.thinking ? { thinking: runConfig.thinking } : {}),
						// Thread the run abort into the model call so a Stop tears the
						// in-flight turn down (provider passes it to fetch; the consumer
						// also races it). Inert when never aborted.
						signal: this.ctx.abortController.signal,
					},
					this.ctx.emitEvent,
					this.ctx.drainPending,
					runMgr.id,
					iterationNum,
					forceFinalize,
					this.ctx.log,
					iterSpan,
				)

				// Main-loop turn: also records the prompt size compaction reads.
				runMgr.recordTurnUsage(response.usage)

				if (this.ctx.pluginManager) {
					const hookResults = await this.ctx.pluginManager.executeHooks(
						'post_llm_call',
						{ runId: runMgr.id, iteration: iterationNum },
						this.ctx.emitEvent,
					)
					applyLifecycleHookResults('post_llm_call', hookResults)
					yield* this.ctx.drainPending()
				}

				this.ctx.log.debug('LLM response received', {
					runId: runMgr.id,
					iteration: iterationNum,
					finishReason: response.finishReason,
					hasContent: response.message.content !== null && response.message.content.length > 0,
					toolCallCount: response.message.toolCalls?.length ?? 0,
					promptTokens: response.usage.promptTokens,
					completionTokens: response.usage.completionTokens,
					totalTokens: runMgr.tokenUsage.totalTokens,
					totalCost: runMgr.costInfo.totalCost,
				})

				await this.ctx.emitEvent({
					type: 'token_usage_updated',
					runId: runMgr.id,
					usage: runMgr.tokenUsage,
					cost: runMgr.costInfo,
				})

				// Reasoning rides along with the turn it belongs to, so the
				// replay contract holds automatically: trimming or compacting
				// the assistant message takes its thinking blocks with it,
				// and no separate atomicity rule is needed.
				const assistantMsg = createAssistantMessage(
					response.message.content,
					forceFinalize ? undefined : response.message.toolCalls,
					response.message.reasoning,
				)
				runMgr.pushMessage(assistantMsg)

				if (this.ctx.workingStateManager && this.ctx.compactionConfig && assistantMsg.content) {
					extractFromAssistantMessage(
						this.ctx.workingStateManager,
						assistantMsg.content,
						this.ctx.compactionConfig,
					)
				}

				yield* this.ctx.drainPending()

				iterSpan.setAttributes({
					[GENAI.USAGE_INPUT_TOKENS]: response.usage.promptTokens,
					[GENAI.USAGE_OUTPUT_TOKENS]: response.usage.completionTokens,
				})
				iterSpan.setStatus({ code: SpanStatusCode.OK })

				if (iterationActivity) {
					this.ctx.activityStore.complete(iterationActivity.id, {
						content: response.message.content,
						hasToolCalls: forceFinalize ? false : !!response.message.toolCalls?.length,
					})
				}

				if (
					forceFinalize ||
					response.finishReason === 'stop' ||
					!response.message.toolCalls ||
					response.message.toolCalls.length === 0
				) {
					// Every task-dispatch tool (create_task, continue_task, Agent)
					// is BLOCKING: the worker's output returns as the dispatching
					// tool_use's canonical tool_result, so by the time the model
					// ends its turn nothing launched by this run should still be
					// in flight. A running task here is an orphan (interrupted
					// tool execution, cancel race) with no delivery path back to
					// the parent — the <task-notification> producer was removed
					// in dc16d58, so waiting on the queue could only ever time
					// out. Log the orphans honestly and end the turn normally.
					if (!forceFinalize && this.hasRunningAgentTasks()) {
						this.ctx.log.warn(
							'LLM ended turn with agent tasks still running — ending run without waiting (orphan tasks have no delivery path)',
							{
								runId: runMgr.id,
								iteration: iterationNum,
							},
						)
					}

					const hasContent =
						response.message.content !== null && response.message.content.length > 0

					// Auto-continuation on `stop_reason: max_tokens`. The
					// model hit its per-call output cap mid-text (NOT
					// mid-tool-use — that path is handled separately
					// below via `inputTruncated`). Push a synthetic
					// "continue" user message and let the loop fire
					// another turn. The provider receives the partial
					// assistant content + the continue prompt and
					// resumes from where it left off, mirroring the
					// Claude.ai "Continue" affordance.
					//
					// Guards:
					//   - `hasContent` so we don't loop forever on an
					//     empty cutoff (Anthropic occasionally emits
					//     `stop_reason: max_tokens` with no content
					//     when an injected pre-fill blocks the model).
					//   - `!forceFinalize` so the forced-finalize path
					//     never auto-continues — that path is invoked
					//     specifically to extract a closing summary.
					//   - max_iterations bounds the loop in any case.
					if (!forceFinalize && response.finishReason === 'length' && hasContent) {
						this.ctx.log.info('LLM hit max_tokens mid-text — auto-continuing', {
							runId: runMgr.id,
							iteration: iterationNum,
							completionTokens: response.usage.completionTokens,
						})
						runMgr.pushMessage(createUserMessage(AUTO_CONTINUATION_USER_MESSAGE))
						await this.ctx.emitEvent({
							type: 'iteration_completed',
							runId: runMgr.id,
							iteration: iterationNum,
							hasToolCalls: false,
						})
						yield* this.ctx.drainPending()
						iterSpan.end()
						continue
					}

					if (!hasContent && !forceFinalize) {
						this.ctx.log.warn('Empty completion detected — requesting final summary', {
							iteration: iterationNum,
							finishReason: response.finishReason,
						})
						await this.requestFinalResponse(model, 'end_turn')
						yield* this.ctx.drainPending()
					}

					await this.ctx.emitEvent({
						type: 'iteration_completed',
						runId: runMgr.id,
						iteration: iterationNum,
						hasToolCalls: false,
					})
					yield* this.ctx.drainPending()
					// A Stop that lands AFTER the final turn streamed but before
					// this break must settle the run as cancelled, not end_turn —
					// otherwise the just-produced answer is recorded as a clean
					// completion. Mirrors the between-iteration cancel at :511.
					if (this.ctx.abortController.signal.aborted) {
						runMgr.setStopReason('cancelled')
						runMgr.markCancelled()
						iterSpan.end()
						break
					}
					runMgr.setStopReason('end_turn')
					iterSpan.end()
					break
				}

				const reviewOutcome = yield* runToolReview(this.ctx, response, iterationNum)

				// The step record is built even for a rejected batch: a run that
				// spent a turn getting its tools refused still spent the tokens,
				// and a caller reconstructing cost per step must see it.
				this.recordStep({
					stepNumber: iterationNum,
					model,
					messageId,
					response,
					toolResults: reviewOutcome.results,
					toolExecutionMs: reviewOutcome.durationMs,
					startedAt: stepStartedAt,
					usageBefore,
					costBefore,
				})

				if (reviewOutcome.decision === 'stop') {
					iterSpan.end()
					return
				}

				if (reviewOutcome.decision === 'rejected') {
					iterSpan.end()
					continue
				}

				// Evaluated AFTER the tools ran, so a predicate can see what they
				// returned — which is what makes a terminal submit_answer tool
				// usable without discarding its output.
				if (await this.shouldStop()) {
					this.ctx.log.info('Stop condition met', {
						runId: runMgr.id,
						iteration: iterationNum,
					})
					runMgr.setStopReason('stop_condition')
					await this.ctx.emitEvent({
						type: 'iteration_completed',
						runId: runMgr.id,
						iteration: iterationNum,
						hasToolCalls: true,
					})
					yield* this.ctx.drainPending()
					iterSpan.end()
					break
				}

				const checkpointSignal = yield* runIterationCheckpoint(this.ctx, iterationNum)
				if (checkpointSignal === 'stop') {
					iterSpan.end()
					return
				}

				await runAdvisoryPhase(this.ctx, iterationNum, response)

				if (this.ctx.pluginManager) {
					const hookResults = await this.ctx.pluginManager.executeHooks(
						'iteration_end',
						{ runId: runMgr.id, iteration: iterationNum },
						this.ctx.emitEvent,
					)
					applyLifecycleHookResults('iteration_end', hookResults)
					yield* this.ctx.drainPending()
				}

				await this.ctx.emitEvent({
					type: 'iteration_completed',
					runId: runMgr.id,
					iteration: iterationNum,
					hasToolCalls: true,
				})
				yield* this.ctx.drainPending()
				iterSpan.end()
			} catch (err) {
				// A Stop that aborted the in-flight turn surfaces here as a
				// thrown abort (the provider stream was raced against the run
				// signal). Settle it as a CANCELLATION — mirroring the
				// between-iteration cancel at the top of the loop — rather than
				// recording it as an SDK failure (error span + failed activity)
				// and re-throwing. The run then returns cleanly with a
				// 'cancelled' stop reason instead of propagating an error.
				if (this.ctx.abortController.signal.aborted) {
					runMgr.setStopReason('cancelled')
					runMgr.markCancelled()
					iterSpan.end()
					break
				}

				if (iterationActivity) {
					this.ctx.activityStore.fail(iterationActivity.id, toErrorMessage(err))
				}

				iterSpan.setStatus({
					code: SpanStatusCode.ERROR,
					message: toErrorMessage(err),
				})
				iterSpan.recordException(err instanceof Error ? err : new Error(String(err)))
				iterSpan.end()
				throw err
			}
		}
	}

	/** Steps completed so far, exposed on the returned `Run`. */
	private readonly steps: StepResult[] = []

	getSteps(): readonly StepResult[] {
		return this.steps
	}

	/**
	 * Fold one iteration into a `StepResult`.
	 *
	 * Every field here was already computed somewhere in the loop; the only
	 * new work is subtracting the cumulative counters so the step carries
	 * ITS usage rather than the run's running total, which is the number a
	 * caller asking "what did this step cost" actually wants.
	 */
	private recordStep(input: {
		stepNumber: number
		model: string
		messageId: MessageId
		response: ChatCompletionResponse
		toolResults: readonly ToolCallOutcome[]
		toolExecutionMs: number
		startedAt: number
		usageBefore: TokenUsage
		costBefore: CostInfo
	}): void {
		const { runMgr } = this.ctx
		const toolCalls = input.response.message.toolCalls ?? []
		const byId = new Map(input.toolResults.map((r) => [r.toolCallId, r]))

		const step: StepResult = {
			stepNumber: input.stepNumber,
			model: input.model,
			messageId: input.messageId,
			content: input.response.message.content,
			toolCalls,
			// Ordered by the tool CALLS, not by completion, so the record
			// matches what the model asked for.
			toolResults: toolCalls.map((tc) => {
				const outcome = byId.get(tc.id)
				return {
					toolCallId: tc.id,
					toolName: tc.function.name,
					output: outcome?.output ?? '',
					isError: outcome?.isError ?? false,
					durationMs: 0,
				}
			}),
			finishReason: input.response.finishReason,
			usage: subtractUsage(runMgr.tokenUsage, input.usageBefore),
			costDelta: {
				...runMgr.costInfo,
				totalCost: round6(runMgr.costInfo.totalCost - input.costBefore.totalCost),
			},
			startedAt: input.startedAt,
			durationMs: Date.now() - input.startedAt,
			toolExecutionMs: input.toolExecutionMs,
		}

		this.steps.push(step)
		this.ctx.onStepFinish?.(step)
	}

	/** Evaluate the caller's halt predicate, if there is one. */
	private async shouldStop(): Promise<boolean> {
		const stopWhen = this.ctx.stopWhen
		const latestStep = this.steps.at(-1)
		if (!stopWhen || !latestStep) return false
		try {
			return await stopWhen({
				steps: this.steps,
				latestStep,
				totalUsage: this.ctx.runMgr.tokenUsage,
				totalCost: this.ctx.runMgr.costInfo,
			})
		} catch (err) {
			// A throwing predicate must not kill a run that is otherwise
			// healthy; failing open keeps the existing budgets in charge.
			this.ctx.log.error('Stop condition threw — continuing the run', {
				runId: this.ctx.runMgr.id,
				error: toErrorMessage(err),
			})
			return false
		}
	}

	private hasRunningAgentTasks(): boolean {
		if (!this.ctx.taskGateway) return false
		return this.ctx.taskGateway
			.listTasks()
			.some((t) => t.state !== 'completed' && t.state !== 'failed' && t.state !== 'canceled')
	}

	private async requestFinalResponse(model: string, reason: StopReason): Promise<void> {
		const lastAssistant = [...this.ctx.runMgr.messages]
			.reverse()
			.find((m) => m.role === 'assistant')

		const hasResult =
			lastAssistant?.content !== null &&
			lastAssistant?.content !== undefined &&
			lastAssistant.content.length > 0

		if (hasResult) return

		this.ctx.log.info('Requesting final response before limit enforcement', {
			reason,
		})

		try {
			const finalMessages = [
				...this.ctx.runMgr.messages,
				createUserMessage(
					`[SYSTEM] Run is ending due to ${reason}. You MUST provide a final response now summarizing all your findings and work so far. Do not use any tools.`,
				),
			]

			// Same cache discipline as the forced-final iteration: keep the
			// tools param identical to prior iterations (cache prefix intact,
			// no 400 on tool blocks in history) and forbid use via tool_choice.
			const finalTools = this.ctx.tools.toLLMTools(this.ctx.allowedTools)
			const response = await collect(
				this.ctx.provider.chatStream({
					model,
					messages: finalMessages,
					tools: finalTools.length > 0 ? finalTools : undefined,
					toolChoice: finalTools.length > 0 ? 'none' : undefined,
					temperature: this.ctx.runConfig.temperature,
					maxTokens: this.ctx.runConfig.maxResponseTokens,
					cacheControl: { type: 'auto' },
					...(this.ctx.runConfig.thinking ? { thinking: this.ctx.runConfig.thinking } : {}),
					// Cancellable too: a Stop during the closing summary must not
					// stream to completion.
					signal: this.ctx.abortController.signal,
				}),
			)

			this.ctx.runMgr.accumulateUsage(response.usage)

			const assistantMsg = createAssistantMessage(response.message.content)
			this.ctx.runMgr.pushMessage(assistantMsg)

			const finalMessageId = generateMessageId()
			await this.ctx.emitEvent({
				type: 'message_started',
				runId: this.ctx.runMgr.id,
				iteration: this.ctx.runMgr.currentIteration,
				messageId: finalMessageId,
			})
			await this.ctx.emitEvent({
				type: 'message_completed',
				runId: this.ctx.runMgr.id,
				iteration: this.ctx.runMgr.currentIteration,
				messageId: finalMessageId,
				stopReason: 'forced_finalize',
				usage: response.usage,
				content: response.message.content ?? undefined,
			})
		} catch (err) {
			this.ctx.log.error('Failed to get final response', {
				error: toErrorMessage(err),
			})
		}
	}
}

/** Per-step usage: the delta between two cumulative snapshots. */
function subtractUsage(after: TokenUsage, before: TokenUsage): TokenUsage {
	return {
		promptTokens: after.promptTokens - before.promptTokens,
		completionTokens: after.completionTokens - before.completionTokens,
		totalTokens: after.totalTokens - before.totalTokens,
		cachedTokens: (after.cachedTokens ?? 0) - (before.cachedTokens ?? 0),
		cacheWriteTokens: (after.cacheWriteTokens ?? 0) - (before.cacheWriteTokens ?? 0),
	}
}

/** Cost deltas are subtractions of floats; keep them presentable. */
function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6
}
