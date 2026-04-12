import { SpanStatusCode } from '@opentelemetry/api'
import type { AdvisoryContext } from '../../../advisory/context.js'
import { extractFromAssistantMessage } from '../../../compaction/extractor.js'
import type { WorkingStateManager } from '../../../compaction/manager.js'
import type { CompactionConfig } from '../../../config/runtime.js'
import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { getTracer } from '../../../provider/telemetry/setup.js'
import type { ActivityStore } from '../../../store/activity/memory.js'
import { GENAI, NAMZU, agentIterationSpanName } from '../../../telemetry/attributes.js'
import type { ResumeHandler } from '../../../types/hitl/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { AgentRunConfig, RunEvent, StopReason } from '../../../types/run/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import type { Logger } from '../../../utils/logger.js'
import type { CheckpointManager } from '../checkpoint.js'
import type { EmitEvent } from '../events.js'
import type { ToolExecutor } from '../executor.js'
import type { GuardCoordinator } from '../guard.js'
import { runAdvisoryPhase } from './phases/advisory.js'
import { runIterationCheckpoint } from './phases/checkpoint.js'
import { runCompactionCheck } from './phases/compaction.js'
import type { IterationContext } from './phases/index.js'
import { runPlanGate } from './phases/plan.js'
import { runToolReview } from './phases/tool-review.js'

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
						await this.ctx.pluginManager.executeHooks('iteration_start', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
					}

					if (this.ctx.pendingNotifications.length > 0) {
						await this.injectOneTaskNotification()
					}

					await runCompactionCheck(this.ctx)

					const openAITools = forceFinalize
						? undefined
						: this.ctx.tools.toLLMTools(this.ctx.allowedTools)

					const messages = forceFinalize
						? [
								...runMgr.messages,
								createUserMessage(
									'[SYSTEM] You are approaching your resource limits. Provide your final, comprehensive response now based on everything you have gathered so far. Do not request any more tool calls.',
								),
							]
						: runMgr.messages

					if (this.ctx.pluginManager) {
						await this.ctx.pluginManager.executeHooks('pre_llm_call', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
					}

					const response = await this.ctx.provider.chat({
						model,
						messages,
						tools: openAITools && openAITools.length > 0 ? openAITools : undefined,
						temperature: runConfig.temperature,
						maxTokens: runConfig.maxResponseTokens,
						cacheControl: { type: 'auto' },
					})

					runMgr.accumulateUsage(response.usage)

					if (this.ctx.pluginManager) {
						await this.ctx.pluginManager.executeHooks('post_llm_call', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
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
						await this.ctx.pluginManager.executeHooks('iteration_end', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
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

		const notification = [
			'<task-notification>',
			`  <task-id>${handle.taskId}</task-id>`,
			`  <agent-id>${handle.agentId}</agent-id>`,
			`  <status>${handle.state}</status>`,
			`  <description>${meta?.description ?? 'agent task'}</description>`,
			`  <result>${resultText}</result>`,
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

			const response = await this.ctx.provider.chat({
				model,
				messages: finalMessages,
				temperature: this.ctx.runConfig.temperature,
				maxTokens: this.ctx.runConfig.maxResponseTokens,
				cacheControl: { type: 'auto' },
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
