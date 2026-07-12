import { type Span, SpanStatusCode } from '@opentelemetry/api'
import type { AdvisoryContext } from '../../../advisory/context.js'
import { repairDanglingMessages } from '../../../compaction/dangling.js'
import { extractFromAssistantMessage } from '../../../compaction/extractor.js'
import type { WorkingStateManager } from '../../../compaction/manager.js'
import type { CompactionConfig } from '../../../config/runtime.js'
import { FINAL_RESPONSE_GRACE_MS } from '../../../constants/limits.js'
import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { isProviderRequestError } from '../../../provider/errors.js'
import type { ActivityStore } from '../../../store/activity/memory.js'
import { GENAI, NAMZU, agentIterationSpanName } from '../../../telemetry/attributes.js'
import { getTracer } from '../../../telemetry/runtime-accessors.js'
import type { Activity } from '../../../types/activity/index.js'
import type { ResumeHandler } from '../../../types/hitl/index.js'
import {
	type Message,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import type { AgentRunConfig, RetryConfig, RunEvent, StopReason } from '../../../types/run/index.js'
import type { LLMToolSchema, ToolRegistryContract } from '../../../types/tool/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import type { Logger } from '../../../utils/logger.js'
import { escapeXmlText } from '../../../utils/xml.js'
import type { CheckpointManager } from '../checkpoint.js'
import type { EmitEvent } from '../events.js'
import type { ToolExecutor } from '../executor.js'
import type { GuardCoordinator } from '../guard.js'
import { attemptModelCall, resolveRetryConfig } from '../model-call.js'
import { applyLifecycleHookResults } from '../plugin-hooks.js'
import { runAdvisoryPhase } from './phases/advisory.js'
import { runIterationCheckpoint } from './phases/checkpoint.js'
import { reduceMessagesForOverflow, runCompactionCheck } from './phases/compaction.js'
import type { IterationContext } from './phases/index.js'
import { runPlanGate } from './phases/plan.js'
import { runToolReview } from './phases/tool-review.js'

/**
 * Synthetic user prompt appended when the guard forces finalization (warning
 * state near a resource limit). Extracted so the reactive overflow-reissue path
 * rebuilds the outbound messages with byte-identical semantics.
 */
const FORCE_FINALIZE_PROMPT =
	'[SYSTEM] You are approaching your resource limits. Provide your final, comprehensive response now based on everything you have gathered so far. Do not request any more tool calls.'

/**
 * Content of a synthesized tool result standing in for a tool call the model
 * requested in a response that the provider truncated (`finishReason: 'length'`)
 * before the request completed. Not executed — the pair only exists to keep the
 * assistant/tool sequence provider-valid so the next iteration can retry.
 */
const TRUNCATED_TOOL_RESULT_CONTENT =
	'[SYSTEM] Tool not executed: the model response was truncated (finishReason: length) before this tool call completed. Retry with a shorter response.'

export type { IterationContext } from './phases/index.js'
export type { PhaseSignal } from './phases/index.js'
export type { ToolReviewOutcome } from './phases/index.js'

export interface IterationConfig {
	provider: LLMProvider
	runConfig: AgentRunConfig
	tools: ToolRegistryContract
	allowedTools?: string[]
	taskGateway?: import('../../../types/agent/gateway.js').TaskGateway
	taskStore?: import('../../../types/task/index.js').TaskStore
	launchedTasks?: Map<
		import('../../../types/ids/index.js').TaskId,
		import('./phases/context.js').LaunchedTaskMeta
	>
	compactionConfig?: CompactionConfig
	workingStateManager?: WorkingStateManager
	advisoryCtx?: AdvisoryContext
	agentBus?: import('../../../bus/index.js').AgentBus
	verificationGate?: import('../../../verification/gate.js').VerificationGate
	pluginManager?: import('../../../plugin/lifecycle.js').PluginLifecycleManager
}

export class IterationOrchestrator {
	private ctx: IterationContext

	constructor(
		config: IterationConfig,
		runMgr: RunPersistence,
		toolExecutor: ToolExecutor,
		guard: GuardCoordinator,
		activityStore: ActivityStore,
		emitEvent: EmitEvent,
		drainPending: () => Generator<RunEvent>,
		abortController: AbortController,
		log: Logger,
		resumeHandler: ResumeHandler,
		checkpointMgr: CheckpointManager,
		planManager: PlanManager,
	) {
		this.ctx = {
			provider: config.provider,
			runConfig: config.runConfig,
			tools: config.tools,
			allowedTools: config.allowedTools,
			runMgr,
			toolExecutor,
			guard,
			activityStore,
			emitEvent,
			drainPending,
			abortController,
			log,
			resumeHandler,
			checkpointMgr,
			planManager,
			taskGateway: config.taskGateway,
			taskStore: config.taskStore,
			pendingNotifications: [],
			launchedTasks: config.launchedTasks ?? new Map(),
			compactionConfig: config.compactionConfig,
			workingStateManager: config.workingStateManager,
			advisoryCtx: config.advisoryCtx,
			agentBus: config.agentBus,
			verificationGate: config.verificationGate,
			pluginManager: config.pluginManager,
		}
	}

	async *runLoop(): AsyncGenerator<RunEvent> {
		const { runConfig, runMgr } = this.ctx
		const { model } = runConfig
		const tracer = getTracer()

		let unsubscribeTaskListener: (() => void) | undefined
		if (this.ctx.taskGateway) {
			unsubscribeTaskListener = this.ctx.taskGateway.onTaskCompleted((handle) => {
				this.ctx.pendingNotifications.push(handle)
				this.ctx.log.debug('Task completion queued for notification', {
					taskId: handle.taskId,
					agentId: handle.agentId,
					state: handle.state,
				})
			})
		}

		try {
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

				const iterSpan = tracer.startSpan(agentIterationSpanName(iterationNum))
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

					if (this.ctx.pendingNotifications.length > 0) {
						await this.injectOneTaskNotification()
					}

					await runCompactionCheck(this.ctx)

					const openAITools = forceFinalize
						? undefined
						: this.ctx.tools.toLLMTools(this.ctx.allowedTools)

					const messages = forceFinalize
						? [...runMgr.messages, createUserMessage(FORCE_FINALIZE_PROMPT)]
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

					const retry = resolveRetryConfig(runConfig)
					const response = await this.callModelWithOverflowRecovery(
						messages,
						openAITools,
						model,
						retry,
						forceFinalize,
					)

					// SANITIZE EARLY (A6, round-2 M11): a length-truncated tool
					// call may carry invalid JSON arguments; repair them to '{}'
					// before the call is recorded or any provider re-serializes
					// the assistant message.
					if (response.finishReason === 'length' && response.message.toolCalls) {
						for (const tc of response.message.toolCalls) {
							try {
								JSON.parse(tc.function.arguments)
							} catch {
								tc.function.arguments = '{}'
							}
						}
					}

					runMgr.accumulateUsage(response.usage)

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

					// Post-success order (A4, round-2 M6): accumulateUsage →
					// token_usage_updated → post_llm_call → abort check. On a
					// post-success abort we still account usage and fire the post
					// hook (observers see the completed call) but push no assistant
					// message and run no tools, avoiding a dangling tool-call pair.
					await this.ctx.emitEvent({
						type: 'token_usage_updated',
						runId: runMgr.id,
						usage: runMgr.tokenUsage,
						cost: runMgr.costInfo,
					})

					if (this.ctx.pluginManager) {
						const hookResults = await this.ctx.pluginManager.executeHooks(
							'post_llm_call',
							{ runId: runMgr.id, iteration: iterationNum },
							this.ctx.emitEvent,
						)
						applyLifecycleHookResults('post_llm_call', hookResults)
					}
					yield* this.ctx.drainPending()

					if (this.ctx.abortController.signal.aborted) {
						this.enterCancellationPath(iterationActivity, iterSpan)
						break
					}

					const assistantMsg = createAssistantMessage(
						response.message.content,
						forceFinalize ? undefined : response.message.toolCalls,
					)
					runMgr.pushMessage(assistantMsg)

					if (this.ctx.workingStateManager && this.ctx.compactionConfig && assistantMsg.content) {
						extractFromAssistantMessage(
							this.ctx.workingStateManager,
							assistantMsg.content,
							this.ctx.compactionConfig,
						)
					}

					await this.ctx.emitEvent({
						type: 'llm_response',
						runId: runMgr.id,
						content: response.message.content,
						hasToolCalls: forceFinalize ? false : !!response.message.toolCalls?.length,
					})

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

					// finishReason 'length' handling (A6, round-2 M11/M12). Only
					// for real model turns (never forced finalize). With tool
					// calls the turn was truncated mid-request: do NOT execute
					// them; push a synthesized not-executed result per call to keep
					// the assistant/tool pair provider-valid, then close the
					// iteration through the normal tail (iteration_end hook +
					// iteration_completed + span end) and continue. Without tool
					// calls: warn + span attribute and fall through to end-turn.
					if (!forceFinalize && response.finishReason === 'length') {
						const truncatedCalls = response.message.toolCalls
						if (truncatedCalls && truncatedCalls.length > 0) {
							this.ctx.log.warn('LLM response truncated (length) with tool calls — not executing', {
								runId: runMgr.id,
								iteration: iterationNum,
								toolCallCount: truncatedCalls.length,
							})
							for (const tc of truncatedCalls) {
								runMgr.pushMessage(createToolMessage(TRUNCATED_TOOL_RESULT_CONTENT, tc.id))
							}

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
							continue
						}

						this.ctx.log.warn('LLM response truncated (length) with no tool calls', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
						iterSpan.setAttribute(NAMZU.RESPONSE_TRUNCATED, true)
					}

					if (
						forceFinalize ||
						response.finishReason === 'stop' ||
						!response.message.toolCalls ||
						response.message.toolCalls.length === 0
					) {
						const hasRunningTasks = this.hasRunningAgentTasks()
						const hasPendingNotifications = this.ctx.pendingNotifications.length > 0

						if (!forceFinalize && (hasRunningTasks || hasPendingNotifications)) {
							this.ctx.log.info(
								'LLM ended turn but agent tasks still running — waiting for notifications',
								{
									runId: runMgr.id,
									runningTasks: hasRunningTasks,
									pendingNotifications: hasPendingNotifications,
								},
							)

							await this.ctx.emitEvent({
								type: 'iteration_completed',
								runId: runMgr.id,
								iteration: iterationNum,
								hasToolCalls: false,
							})
							yield* this.ctx.drainPending()
							iterSpan.end()

							yield* this.waitAndInjectNotifications()
							continue
						}

						const hasContent =
							response.message.content !== null && response.message.content.length > 0

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
						runMgr.setStopReason('end_turn')
						iterSpan.end()
						break
					}

					const reviewOutcome = yield* runToolReview(this.ctx, response, iterationNum)

					if (reviewOutcome === 'stop') {
						iterSpan.end()
						return
					}

					if (reviewOutcome === 'rejected') {
						iterSpan.end()
						continue
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
					// Cancellation takes priority: an aborted signal (or an
					// 'aborted' provider error) heals the history and stops the run
					// as cancelled rather than failed (A4).
					if (
						this.ctx.abortController.signal.aborted ||
						(isProviderRequestError(err) && err.kind === 'aborted')
					) {
						this.enterCancellationPath(iterationActivity, iterSpan)
						break
					}

					// A retry loop that exhausted the run deadline surfaces as a
					// timeout stop (mirrors the guard hard-stop path) rather than a
					// run failure (A3, round-2 M8). Gate strictly on a RETRYABLE
					// transport error (throttle/server/network) whose retries ran out
					// against the deadline — a terminal auth/bad_request/unknown error
					// or a tool-execution exception that merely happens to surface
					// after the deadline keeps the normal failure path with the
					// ORIGINAL error preserved, so misconfiguration is never masked as
					// a timeout (ses_015 fix-batch).
					if (
						Date.now() >= this.ctx.guard.deadlineAt &&
						isProviderRequestError(err) &&
						(err.kind === 'throttle' || err.kind === 'server' || err.kind === 'network')
					) {
						this.ctx.log.info('Model call exhausted run deadline — enforcing timeout stop', {
							runId: runMgr.id,
							iteration: iterationNum,
							kind: err.kind,
						})
						if (iterationActivity) {
							this.ctx.activityStore.fail(iterationActivity.id, 'timeout')
						}
						iterSpan.setStatus({
							code: SpanStatusCode.ERROR,
							message: 'run deadline exceeded',
						})
						iterSpan.end()
						// Heal any dangling assistant/tool pair in place before the
						// final call so requestFinalResponse's chat cannot be rejected
						// for a dangling pair (mirrors the cancellation path).
						this.healHistoryInPlace()
						await this.requestFinalResponse(model, 'timeout')
						yield* this.ctx.drainPending()
						runMgr.setStopReason('timeout')
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
		} finally {
			unsubscribeTaskListener?.()
		}
	}

	private hasRunningAgentTasks(): boolean {
		if (!this.ctx.taskGateway) return false
		return this.ctx.taskGateway
			.listTasks()
			.some((t) => t.state !== 'completed' && t.state !== 'failed' && t.state !== 'canceled')
	}

	private async *waitAndInjectNotifications(): AsyncGenerator<RunEvent> {
		const deadline = Date.now() + (this.ctx.runConfig.timeoutMs ?? 120_000)
		while (
			this.ctx.pendingNotifications.length === 0 &&
			Date.now() < deadline &&
			!this.ctx.abortController.signal.aborted
		) {
			await new Promise((r) => setTimeout(r, 250))
		}

		await this.injectOneTaskNotification()
	}

	private async injectOneTaskNotification(): Promise<void> {
		const handle = this.ctx.pendingNotifications.shift()
		if (!handle) return
		const meta = this.ctx.launchedTasks.get(handle.taskId)
		const resultText =
			handle.result?.result ??
			handle.result?.lastError ??
			`Task finished with state: ${handle.state}`

		if (meta?.planTaskId && this.ctx.taskStore) {
			const success = handle.state === 'completed'
			await this.ctx.taskStore.update(meta.planTaskId as `task_${string}`, {
				status: 'completed',
				description: success ? undefined : `Failed: ${resultText.substring(0, 200)}`,
			})
		}

		this.ctx.launchedTasks.delete(handle.taskId)
		const remainingTasks = this.ctx.launchedTasks.size

		// Every interpolated field is model- or tool-derived (the sub-agent's own
		// final text, its last error, the launch-time description). Unescaped, a
		// literal `</task-notification>` in that content forges a frame in the
		// parent's transcript.
		const notification = [
			'<task-notification>',
			`  <task-id>${escapeXmlText(handle.taskId)}</task-id>`,
			`  <agent-id>${escapeXmlText(handle.agentId)}</agent-id>`,
			`  <status>${escapeXmlText(handle.state)}</status>`,
			`  <description>${escapeXmlText(meta?.description ?? 'agent task')}</description>`,
			`  <result>${escapeXmlText(resultText)}</result>`,
			`  <remaining-tasks>${remainingTasks}</remaining-tasks>`,
			'</task-notification>',
		].join('\n')

		this.ctx.runMgr.pushMessage(createUserMessage(notification))

		this.ctx.log.info('Task notification injected', {
			taskId: handle.taskId,
			agentId: handle.agentId,
			state: handle.state,
			planTaskId: meta?.planTaskId,
			remainingTasks,
			remainingNotifications: this.ctx.pendingNotifications.length,
		})
	}

	/**
	 * Heal and terminate the run as cancelled. Shared by the post-success abort
	 * check and the iteration catch (A4). Cancels the iteration activity, marks
	 * the span OK with a `namzu.cancelled` attribute, repairs the run's own
	 * persisted history in place (so a later resume/replay of THIS run is
	 * provider-valid, round-2 M7), then sets the stop reason and marks cancelled.
	 * Callers must `break` the loop after calling this.
	 */
	private enterCancellationPath(iterationActivity: Activity | null, iterSpan: Span): void {
		const { runMgr } = this.ctx
		this.ctx.log.info('Run cancelled during iteration — healing history', {
			runId: runMgr.id,
			iteration: runMgr.currentIteration,
		})

		if (iterationActivity) {
			this.ctx.activityStore.cancel(iterationActivity.id)
		}

		iterSpan.setStatus({ code: SpanStatusCode.OK })
		iterSpan.setAttribute(NAMZU.CANCELLED, true)
		iterSpan.end()

		this.healHistoryInPlace()

		runMgr.setStopReason('cancelled')
		runMgr.markCancelled()
	}

	/**
	 * Repair the run's own persisted history in place so any dangling assistant
	 * tool-call pair is healed ({@link repairDanglingMessages}) — making a later
	 * resume/replay of this run, and any immediately-following model call (e.g.
	 * requestFinalResponse), provider-valid. Shared by the cancellation path and
	 * the deadline-timeout path (ses_015 fix-batch).
	 */
	private healHistoryInPlace(): void {
		const { runMgr } = this.ctx
		const repaired = repairDanglingMessages(runMgr.messages)
		runMgr.messages.length = 0
		for (const msg of repaired) {
			runMgr.messages.push(msg)
		}
	}

	/**
	 * Issue the main model call with bounded retries ({@link attemptModelCall})
	 * and reactive context-overflow recovery (A5). On a `context_overflow`
	 * provider error, up to `retry.overflowAttempts` times: drain pending task
	 * notifications into history (M16), reduce the live history
	 * ({@link reduceMessagesForOverflow}), rebuild the outbound messages exactly
	 * as the original construction, and reissue within the same iteration. If the
	 * reducer cannot shrink further, the overflow error is rethrown. An abort
	 * mid-reissue surfaces as an `aborted` error handled by the iteration catch.
	 */
	private async callModelWithOverflowRecovery(
		messages: Message[],
		openAITools: LLMToolSchema[] | undefined,
		model: string,
		retry: RetryConfig,
		forceFinalize: boolean,
	): Promise<ChatCompletionResponse> {
		const buildParams = (msgs: Message[]): ChatCompletionParams => ({
			model,
			messages: msgs,
			tools: openAITools && openAITools.length > 0 ? openAITools : undefined,
			temperature: this.ctx.runConfig.temperature,
			maxTokens: this.ctx.runConfig.maxResponseTokens,
			cacheControl: { type: 'auto' },
		})

		let currentMessages = messages
		let overflowAttempts = 0

		while (true) {
			try {
				return await attemptModelCall({
					provider: this.ctx.provider,
					params: buildParams(currentMessages),
					retry,
					signal: this.ctx.abortController.signal,
					deadlineAt: this.ctx.guard.deadlineAt,
					log: this.ctx.log,
				})
			} catch (err) {
				if (!isProviderRequestError(err) || err.kind !== 'context_overflow') {
					throw err
				}
				if (overflowAttempts >= retry.overflowAttempts) {
					throw err
				}
				overflowAttempts++

				// Drain pending task notifications into history BEFORE reducing so
				// the reducer preserves/summarises them rather than the reissue
				// silently dropping completed-task results (round-2 M16).
				while (this.ctx.pendingNotifications.length > 0) {
					await this.injectOneTaskNotification()
				}

				const reduced = reduceMessagesForOverflow(this.ctx)
				if (!reduced) {
					throw err
				}

				currentMessages = forceFinalize
					? [...this.ctx.runMgr.messages, createUserMessage(FORCE_FINALIZE_PROMPT)]
					: this.ctx.runMgr.messages
			}
		}
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

			// Best-effort: own 30s grace budget (not the already-exhausted run
			// deadline, round-2 B3), capped at 2 attempts.
			const response = await attemptModelCall({
				provider: this.ctx.provider,
				params: {
					model,
					messages: finalMessages,
					temperature: this.ctx.runConfig.temperature,
					maxTokens: this.ctx.runConfig.maxResponseTokens,
					cacheControl: { type: 'auto' },
				},
				retry: { ...resolveRetryConfig(this.ctx.runConfig), maxAttempts: 2 },
				signal: this.ctx.abortController.signal,
				deadlineAt: Date.now() + FINAL_RESPONSE_GRACE_MS,
				log: this.ctx.log,
			})

			this.ctx.runMgr.accumulateUsage(response.usage)

			const assistantMsg = createAssistantMessage(response.message.content)
			this.ctx.runMgr.pushMessage(assistantMsg)

			await this.ctx.emitEvent({
				type: 'llm_response',
				runId: this.ctx.runMgr.id,
				content: response.message.content,
				hasToolCalls: false,
			})
		} catch (err) {
			this.ctx.log.error('Failed to get final response', {
				error: toErrorMessage(err),
			})
		}
	}
}
