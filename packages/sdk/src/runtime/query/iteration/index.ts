import { type Span, SpanStatusCode } from '@opentelemetry/api'
import { extractFromAssistantMessage } from '../../../compaction/extractor.js'
import { AUTO_CONTINUATION_USER_MESSAGE } from '../../../constants/continuation.js'
import {
	DEFAULT_STRUCTURED_OUTPUT_RETRIES,
	STRUCTURED_OUTPUT_REPROMPT,
} from '../../../constants/tools/index.js'
import { collect } from '../../../provider/collect.js'
import {
	GENAI,
	NAMZU,
	agentIterationSpanName,
	parentContext,
} from '../../../telemetry/attributes.js'
import { getTracer } from '../../../telemetry/runtime-accessors.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../tools/builtins/structuredOutput.js'
import type { CostInfo, TokenUsage } from '../../../types/common/index.js'
import type { MessageId } from '../../../types/ids/index.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ToolChoice } from '../../../types/provider/chat.js'
import { classifyProviderError } from '../../../types/provider/errors.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { AnswerReview } from '../../../types/run/answer-review.js'
import type {
	PrepareStepResult,
	RunEvent,
	StepResult,
	StopReason,
} from '../../../types/run/index.js'
import type { LLMToolSchema, ToolRegistryContract } from '../../../types/tool/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import { generateMessageId } from '../../../utils/id.js'
import type { ToolCallOutcome } from '../executor.js'
import { applyLifecycleHookResults } from '../plugin-hooks.js'
import { runAdvisoryPhase } from './phases/advisory.js'
import { runIterationCheckpoint } from './phases/checkpoint.js'
import { relieveOverflow, runCompactionCheck } from './phases/compaction.js'
import type { IterationContext } from './phases/index.js'
import { runPlanGate } from './phases/plan.js'
import { runToolReview } from './phases/tool-review.js'
import { refreshWorkingMemory } from './phases/working-memory.js'
import { streamProviderTurn } from './stream-turn.js'

export type { IterationContext } from './phases/index.js'
export type { PhaseSignal } from './phases/index.js'
export type { ToolReviewOutcome } from './phases/index.js'

/**
 * How many times an answer may be handed back before the run stops.
 *
 * Bounded for the same reason the structured-output re-prompt is: a judge
 * that never accepts would otherwise spend the whole token budget
 * rediscovering that, and the run would end on a budget error rather than
 * on the thing that actually went wrong.
 */
const DEFAULT_ANSWER_REVIEW_LIMIT = 3

export class IterationOrchestrator {
	private ctx: IterationContext
	/** Rejections so far. See {@link DEFAULT_ANSWER_REVIEW_LIMIT}. */
	private answerReviewAttempts = 0

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

		// One context-overflow relief per *stuck point*, not per run.
		//
		// The latch exists so that a second overflow immediately after a
		// successful compaction — meaning the prompt is irreducible — stops
		// instead of looping. It was never meant to disarm the mechanism for
		// the rest of the run, which is what a run-scoped flag did: one
		// relief at iteration 3 left iteration 40 to die on an overflow with
		// obvious moves left. It is cleared by a turn that actually
		// succeeded, which is the evidence that the run is no longer stuck.
		let overflowRelieved = false

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
			try {
				// Tool spans for this turn belong under this iteration. Inside
				// the try rather than before it: a throw from any of these left
				// the span open, and an iteration span that never ends is a
				// trace that never closes — the export is incomplete for exactly
				// the run that failed.
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

				// Shape this step before calling the model. `stopWhen` decides
				// whether to keep going; this decides HOW. No-op when the host
				// supplied no hook.
				const step = await this.prepareStep(iterationNum)

				const llmTools = this.ctx.tools.toLLMTools(step.allowedTools ?? this.ctx.allowedTools)
				const enforceToolInputSchema = enforcedModelInputToolNames(this.ctx.tools, llmTools)
				const stepModel = step.model ?? model

				const baseMessages = forceFinalize
					? [
							...runMgr.messages,
							createUserMessage(
								'[SYSTEM] You are approaching your resource limits. Provide your final, comprehensive response now based on everything you have gathered so far. Do not request any more tool calls.',
							),
						]
					: runMgr.messages

				// Step guidance is appended to the REQUEST, never pushed onto
				// the run's history: it applies to this step only, and pushing
				// it would accumulate one stale instruction per iteration.
				// Copy before it crosses the provider boundary. `runMgr.messages`
				// is the LIVE run array, and the loop pushes onto it after the
				// call returns — so a driver that retains what it was handed
				// (to log it, cache it, or replay it on retry) watched its own
				// input grow new turns underneath it. A capture provider in the
				// estate recorded every turn as identical to the last for
				// exactly this reason. Shallow is enough: the defect is array
				// mutation, and per-iteration this is trivial next to the model
				// call it precedes.
				const messages = step.system
					? [...baseMessages, createSystemMessage(step.system)]
					: [...baseMessages]

				if (this.ctx.pluginManager) {
					const hookResults = await this.ctx.pluginManager.executeHooks(
						'pre_llm_call',
						{
							runId: runMgr.id,
							iteration: iterationNum,
							// Built inside the guard: a run with no plugins installed
							// pays nothing for a projection nobody reads.
							request: Object.freeze({
								model: stepModel,
								// Copied per turn, not handed over live: these are the
								// run's own message objects, and a hook writing into
								// one would edit the history the run is about to send.
								messages: Object.freeze(messages.map((m) => Object.freeze({ ...m }))),
								toolNames: Object.freeze(llmTools.map((t) => t.function.name)),
								temperature: step.temperature ?? runConfig.temperature,
								maxTokens: step.maxResponseTokens ?? runConfig.maxResponseTokens,
							}),
						},
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
						model: stepModel,
						messages,
						tools: llmTools.length > 0 ? llmTools : undefined,
						...(enforceToolInputSchema ? { enforceToolInputSchema } : {}),
						// The forced-final turn wins: a step that asked to force a
						// tool cannot override the loop's own decision to stop
						// asking for them. Otherwise the step's choice applies —
						// and only to this step, because the next one is prepared
						// from scratch.
						toolChoice:
							forceFinalize && llmTools.length > 0
								? 'none'
								: llmTools.length > 0
									? step.toolChoice
									: undefined,
						temperature: step.temperature ?? runConfig.temperature,
						maxTokens: step.maxResponseTokens ?? runConfig.maxResponseTokens,
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

				// The turn went through, so the run is not sitting on an
				// irreducible prompt any more. Re-arm relief for the next one.
				overflowRelieved = false

				if (this.ctx.pluginManager) {
					const hookResults = await this.ctx.pluginManager.executeHooks(
						'post_llm_call',
						{
							runId: runMgr.id,
							iteration: iterationNum,
							response: Object.freeze({
								content: response.message.content,
								toolNames: Object.freeze(
									(response.message.toolCalls ?? []).map((c) => c.function.name),
								),
								finishReason: response.finishReason,
								usage: Object.freeze({ ...response.usage }),
							}),
						},
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
					// Rides with the turn it belongs to, like reasoning does, so
					// trimming or compacting the turn takes its evidence with it
					// rather than leaving citations pointing at prose that is gone.
					response.message.citations,
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

				// Tool calls beat the finish reason. The reason is the
				// provider's SUMMARY of the turn and the tool calls are the
				// turn itself, so when they disagree the calls are the fact.
				// Several function-calling endpoints — gateways and local servers
				// especially — report `stop` alongside a populated
				// `tool_calls`, and three of this repo's drivers pass that
				// value through untouched.
				//
				// Reading `stop` first meant the turn ended with every
				// requested call silently skipped, an assistant message
				// carrying tool_use blocks that were never answered, and a
				// run that settled `end_turn` having done nothing it was
				// asked to do. Checking the calls first costs nothing when
				// the provider is honest and is the only thing that saves the
				// run when it is not.
				const hasToolCalls = (response.message.toolCalls?.length ?? 0) > 0

				if (forceFinalize || !hasToolCalls) {
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
					// Auto-continuation after an output-ceiling cutoff.
					//
					// Guards:
					//   - `hasContent` so we don't loop forever on an
					//     empty cutoff (a provider occasionally emits
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
						continue
					}

					// The model tried to finish in prose while a structured
					// output was demanded. Send it back with the schema error
					// rather than returning an unusable result — this is the
					// re-prompt half, and it is bounded so a model that cannot
					// satisfy the schema fails loudly instead of looping.
					if (!forceFinalize && this.needsStructuredOutput()) {
						const attempt = ++this.structuredOutputAttempts
						const limit = this.structuredOutputRetryLimit()
						if (attempt > limit) {
							this.ctx.log.warn('Structured output not produced within its retries', {
								runId: runMgr.id,
								attempts: attempt - 1,
							})
							runMgr.setStopReason('structured_output_failed')
							break
						}
						this.ctx.log.info('Re-prompting for structured output', {
							runId: runMgr.id,
							attempt,
							limit,
						})
						runMgr.pushMessage(createUserMessage(STRUCTURED_OUTPUT_REPROMPT))
						await this.ctx.emitEvent({
							type: 'iteration_completed',
							runId: runMgr.id,
							iteration: iterationNum,
							hasToolCalls: false,
						})
						yield* this.ctx.drainPending()
						continue
					}

					// Let the host judge the ANSWER and hand back work.
					//
					// The stop predicate is only consulted after tools ran, so
					// there was no seam here at all: the moment the model
					// stopped calling tools the run finalized, whatever it had
					// produced. Verify-then-fix — run the build, feed the
					// failure back, let it try again — meant starting a whole
					// new run and re-supplying the context the first one had.
					//
					// Shaped after the structured-output re-prompt directly
					// above, which solves the same problem for one specific
					// judge: bounded attempts, feedback as a user message, and
					// a loud stop rather than a loop.
					if (!forceFinalize && this.ctx.reviewAnswer) {
						const review = await this.reviewAnswer(response.message.content ?? '')
						if (review && !review.accept) {
							const attempt = ++this.answerReviewAttempts
							const limit = this.ctx.maxAnswerReviews ?? DEFAULT_ANSWER_REVIEW_LIMIT
							if (attempt > limit) {
								this.ctx.log.warn('Answer rejected more times than the run allows', {
									runId: runMgr.id,
									attempts: attempt - 1,
									limit,
								})
								runMgr.setStopReason('answer_rejected')
								break
							}
							this.ctx.log.info('Answer rejected — returning it to the model', {
								runId: runMgr.id,
								attempt,
								limit,
							})
							runMgr.pushMessage(createUserMessage(review.feedback))
							await this.ctx.emitEvent({
								type: 'iteration_completed',
								runId: runMgr.id,
								iteration: iterationNum,
								hasToolCalls: false,
							})
							yield* this.ctx.drainPending()
							continue
						}
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
						break
					}
					runMgr.setStopReason('end_turn')
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
					return
				}

				if (reviewOutcome.decision === 'rejected') {
					continue
				}

				// A successful `structured_output` call IS the answer, so the
				// run ends here rather than paying for another turn whose only
				// job would be to restate it.
				if (this.captureStructuredOutput(reviewOutcome.results)) {
					this.ctx.log.info('Structured output produced — ending run', {
						runId: runMgr.id,
						iteration: iterationNum,
					})
					runMgr.setStopReason('end_turn')
					await this.ctx.emitEvent({
						type: 'iteration_completed',
						runId: runMgr.id,
						iteration: iterationNum,
						hasToolCalls: true,
					})
					yield* this.ctx.drainPending()
					break
				}

				// A tool the author declared terminal settles the run with its
				// own output, the same rule `structured_output` has always
				// had. Without it a delegation cost the parent one more model
				// call at full context whose only job was to restate what the
				// worker already said — and to restate it through the parent's
				// compacted view, so the caller did not even receive the
				// worker's words.
				const settled = this.terminalToolOutput(reviewOutcome.results, response)
				if (settled !== undefined) {
					this.ctx.log.info('Terminal tool produced the answer — ending run', {
						runId: runMgr.id,
						iteration: iterationNum,
						tool: settled.toolName,
					})
					runMgr.setResult(settled.output)
					runMgr.setStopReason('end_turn')
					await this.ctx.emitEvent({
						type: 'iteration_completed',
						runId: runMgr.id,
						iteration: iterationNum,
						hasToolCalls: true,
					})
					yield* this.ctx.drainPending()
					break
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
					break
				}

				const checkpointSignal = yield* runIterationCheckpoint(this.ctx, iterationNum)
				if (checkpointSignal === 'stop') {
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
					break
				}

				// The one provider failure the kernel can actually do something
				// about. `context_length_exceeded` is correctly non-retryable —
				// resending the identical prompt cannot help — but the kernel
				// owns a compaction subsystem that can make the prompt smaller.
				// Without this the run died holding the remedy: the threshold
				// path had simply guessed low, which a run carrying images or a
				// language the chars-per-token ratio does not fit will do.
				//
				// Relief is attempted ONCE per iteration and only when it
				// actually shed something. A second overflow after a successful
				// compaction means the prompt is irreducible, and looping on it
				// would burn the budget to arrive at the same error.
				if (
					!overflowRelieved &&
					classifyProviderError(err, this.ctx.provider.id).code === 'context_length_exceeded'
				) {
					overflowRelieved = true
					const shed = await relieveOverflow(this.ctx)
					if (shed) {
						this.ctx.log.info('Retrying the turn after relieving a context overflow', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
						if (iterationActivity) {
							this.ctx.activityStore.complete(iterationActivity.id)
						}
						continue
					}
				}

				if (iterationActivity) {
					this.ctx.activityStore.fail(iterationActivity.id, toErrorMessage(err))
				}

				iterSpan.setStatus({
					code: SpanStatusCode.ERROR,
					message: toErrorMessage(err),
				})
				iterSpan.recordException(err instanceof Error ? err : new Error(String(err)))
				throw err
			} finally {
				// The only place the span ends. It used to be ended at each of
				// seventeen exits, which is a rule every future edit has to
				// remember; a generator abandoned by its consumer never reached
				// any of them.
				iterSpan.end()
			}
		}
	}

	/**
	 * Ask the host how to shape this step.
	 *
	 * Fails OPEN on a throw — same reasoning as `stopWhen` and deliberately
	 * opposite to a guardrail: a broken step-shaping hook should not kill an
	 * otherwise healthy run, and unlike a safety check, nothing unsafe gets
	 * through when it is skipped.
	 */
	private async prepareStep(stepNumber: number): Promise<{
		allowedTools?: string[]
		toolChoice?: ToolChoice
		model?: string
		system?: string
		temperature?: number
		maxResponseTokens?: number
	}> {
		const configured = this.ctx.prepareStep
		if (!configured) return {}
		const stages = Array.isArray(configured) ? configured : [configured]

		// Folded in DECLARATION order, each stage seeing what the ones
		// before it decided. A later stage overriding a field is last-writer
		// wins — visibly, because the order is a line in the host's code
		// rather than an accident of install history.
		let result: PrepareStepResult = {}
		for (const stage of stages) {
			try {
				const decided = await stage({
					runId: this.ctx.runMgr.id,
					stepNumber,
					messages: this.ctx.runMgr.messages,
					steps: this.steps,
					prepared: result,
				})
				if (decided) result = { ...result, ...decided }
			} catch (err) {
				// Skipped, and the rest still run: one broken concern must
				// not silently disable the others it was declared beside.
				this.ctx.log.error('a prepareStep stage threw — skipping it', {
					runId: this.ctx.runMgr.id,
					stepNumber,
					error: toErrorMessage(err),
				})
			}
		}

		const prepared: {
			allowedTools?: string[]
			toolChoice?: ToolChoice
			model?: string
			system?: string
			temperature?: number
			maxResponseTokens?: number
		} = {}

		if (result.activeTools) {
			// A phase list that outlives a tool rename should narrow the
			// surface, not kill the agent mid-run.
			const known = result.activeTools.filter((name: string) => this.ctx.tools.has(name))
			const unknown = result.activeTools.filter((name: string) => !this.ctx.tools.has(name))
			if (unknown.length > 0) {
				this.ctx.log.warn('prepareStep named tools that are not registered — ignoring them', {
					runId: this.ctx.runMgr.id,
					stepNumber,
					unknown,
				})
			}
			prepared.allowedTools = known
		}
		if (result.toolChoice !== undefined) prepared.toolChoice = result.toolChoice
		if (result.model !== undefined) prepared.model = result.model
		if (result.system !== undefined) prepared.system = result.system
		if (result.temperature !== undefined) prepared.temperature = result.temperature
		if (result.maxResponseTokens !== undefined) {
			prepared.maxResponseTokens = result.maxResponseTokens
		}

		return prepared
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

	/** Turns spent asking the model again for a valid structured output. */
	private structuredOutputAttempts = 0
	private structuredOutputDone = false

	private structuredOutputRetryLimit(): number {
		return this.ctx.structuredOutput?.maxRetries ?? DEFAULT_STRUCTURED_OUTPUT_RETRIES
	}

	/** True while a structured output was demanded and has not arrived. */
	private needsStructuredOutput(): boolean {
		return this.ctx.structuredOutput !== undefined && !this.structuredOutputDone
	}

	/**
	 * Record the structured output if this batch produced one.
	 *
	 * The tool validates against the Zod schema before its `execute` runs,
	 * so reaching here successfully means the value is already valid — a
	 * failed parse comes back as an error result and simply does not
	 * satisfy the demand, which sends the loop round again.
	 */
	/**
	 * The answer a terminal tool produced, or `undefined` to keep looping.
	 *
	 * Deliberately narrow. A terminal call decides the run only when it is
	 * the ONLY call the model made in that turn: a model that asked for
	 * other work meant to see those results, and settling here would throw
	 * away answers it requested. Same for a failed terminal call — an
	 * error is not an answer, and the model is the one that should read
	 * it. Both cases fall through to the ordinary path, and both say so in
	 * the log rather than quietly costing the relay the flag was set to
	 * avoid.
	 */
	private terminalToolOutput(
		results: readonly ToolCallOutcome[],
		response: ChatCompletionResponse,
	): ToolCallOutcome | undefined {
		const terminal = results.filter((r) => this.ctx.tools.get(r.toolName)?.terminal === true)
		if (terminal.length === 0) return undefined

		const callCount = response.message.toolCalls?.length ?? 0
		if (callCount > 1) {
			this.ctx.log.info('Terminal tool shared its turn — relaying instead of settling', {
				runId: this.ctx.runMgr.id,
				tool: terminal[0]?.toolName,
				callsInTurn: callCount,
			})
			return undefined
		}

		const hit = terminal[0]
		if (!hit || hit.isError) {
			this.ctx.log.info('Terminal tool failed — returning the error to the model', {
				runId: this.ctx.runMgr.id,
				tool: hit?.toolName,
			})
			return undefined
		}
		return hit
	}

	private captureStructuredOutput(results: readonly ToolCallOutcome[]): boolean {
		if (!this.needsStructuredOutput()) return false
		const hit = results.find((r) => r.toolName === STRUCTURED_OUTPUT_TOOL_NAME && !r.isError)
		if (!hit) return false
		try {
			this.ctx.runMgr.setStructuredOutput(JSON.parse(hit.output))
		} catch {
			// The tool serializes its own validated input, so this is
			// unreachable in practice; keep the raw text rather than losing it.
			this.ctx.runMgr.setStructuredOutput(hit.output)
		}
		this.structuredOutputDone = true
		return true
	}

	/**
	 * Ask the host whether this answer is good enough.
	 *
	 * A hook that throws **accepts**, which is the opposite of what the
	 * safety gates do, and deliberately so. Those are asked "is this
	 * dangerous", where the cost of failing closed is one refused
	 * operation. This is asked "is this good enough", where failing closed
	 * means handing the answer back forever — so a broken judge would turn
	 * every run into a loop that ends on a budget error naming nothing. One
	 * unreviewed answer is the cheaper failure, and the throw is logged at
	 * `error` so it is not mistaken for approval.
	 */
	private async reviewAnswer(answer: string): Promise<AnswerReview | undefined> {
		if (!this.ctx.reviewAnswer) return undefined
		try {
			return await this.ctx.reviewAnswer(answer, {
				runId: this.ctx.runMgr.id,
				iteration: this.ctx.runMgr.currentIteration,
				messages: this.ctx.runMgr.messages,
			})
		} catch (err) {
			this.ctx.log.error('Answer review threw — accepting the answer unreviewed', {
				runId: this.ctx.runMgr.id,
				error: toErrorMessage(err),
			})
			return { accept: true }
		}
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
			const finalEnforced = enforcedModelInputToolNames(this.ctx.tools, finalTools)
			const response = await collect(
				this.ctx.provider.chatStream({
					model,
					messages: finalMessages,
					tools: finalTools.length > 0 ? finalTools : undefined,
					...(finalEnforced ? { enforceToolInputSchema: finalEnforced } : {}),
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

/**
 * Which of the tools going out on this request have a closed model schema.
 *
 * A driver reads `enforceToolInputSchema` to decide which tool schemas to
 * constrain generation against. Nothing populated it, so every driver that
 * consumed it — three of them — was reading a permanently undefined field
 * and `enforceModelInput: true` on a tool meant nothing end to end.
 *
 * Computed per request rather than once, because the allowed set changes:
 * a deferred tool activated mid-run has to start being enforced from the
 * next call, not the next process.
 */
function enforcedModelInputToolNames(
	registry: ToolRegistryContract,
	tools: readonly LLMToolSchema[],
): readonly string[] | undefined {
	const names = tools
		.map((tool) => tool.function.name)
		.filter((name) => registry.get(name)?.enforceModelInput === true)
	return names.length > 0 ? names : undefined
}
