import { SpanStatusCode } from '@opentelemetry/api'
import type { AdvisoryContext } from '../../../advisory/context.js'
import { extractFromAssistantMessage } from '../../../compaction/extractor.js'
import type { WorkingStateManager } from '../../../compaction/manager.js'
import type { CompactionConfig } from '../../../config/runtime.js'
import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { collect } from '../../../provider/collect.js'
import type { ActivityStore } from '../../../store/activity/memory.js'
import { GENAI, NAMZU, agentIterationSpanName } from '../../../telemetry/attributes.js'
import { getTracer } from '../../../telemetry/runtime-accessors.js'
import type { ResumeHandler } from '../../../types/hitl/index.js'
import type { ToolUseId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionResponse,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { AgentRunConfig, RunEvent, StopReason } from '../../../types/run/index.js'
import type { MessageStopReason } from '../../../types/run/stop-reason.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import { generateMessageId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import type { CheckpointManager } from '../checkpoint.js'
import type { EmitEvent } from '../events.js'
import type { ToolExecutor } from '../executor.js'
import type { GuardCoordinator } from '../guard.js'
import { applyLifecycleHookResults } from '../plugin-hooks.js'
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

/**
 * Map a provider's coarse `finishReason` plus the orchestrator's
 * `forceFinalize` flag onto the per-message {@link MessageStopReason}
 * union the v3 `message_completed` event surfaces.
 */
function synthesizeMessageStopReason(
	finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter',
	forceFinalize: boolean,
): MessageStopReason {
	if (forceFinalize) return 'forced_finalize'
	switch (finishReason) {
		case 'tool_calls':
			return 'tool_use'
		case 'length':
			return 'max_tokens'
		case 'content_filter':
			return 'refusal'
		default:
			return 'end_turn'
	}
}

interface StreamingTurnResult {
	response: ChatCompletionResponse
	messageId: import('../../../types/ids/index.js').MessageId
}

/**
 * Consume a provider's streaming response and emit the v3 RunEvent
 * lifecycle natively (message_started → text_delta* + tool_input_*
 * → message_completed). Returns the aggregated `ChatCompletionResponse`
 * for downstream code that still expects the legacy shape (assistant
 * message construction, working-state extraction, telemetry attribute
 * stamping).
 *
 * Per-delta `emitEvent` calls are followed by a `drainPending()`
 * yield so SSE consumers see live progress instead of a burst at
 * end-of-message. The bus's ephemeral filter (D1) ensures these
 * deltas never hit transcript.jsonl.
 *
 * Edge cases (codex A3, A4, A5):
 * - Stream ends without `finishReason` (anthropic-sdk-typescript#842
 *   dropped message_stop): we still emit `message_completed` from a
 *   finally-style fall-through path with `stopReason: 'refusal'`.
 * - `tool_input_delta` with no `toolUseId` registered yet: we drop
 *   the fragment and log a warning (proxies seen to misorder events).
 * - `chunk.error`: we surface as a thrown error after emitting the
 *   message_completed terminator so consumer cards still close.
 */
async function* streamProviderTurn(
	provider: LLMProvider,
	params: import('../../../types/provider/index.js').ChatCompletionParams,
	emitEvent: EmitEvent,
	drainPending: () => Generator<RunEvent>,
	runId: import('../../../types/ids/index.js').RunId,
	iteration: number,
	forceFinalize: boolean,
	log: Logger,
): AsyncGenerator<RunEvent, StreamingTurnResult> {
	const messageId = generateMessageId()
	await emitEvent({ type: 'message_started', runId, iteration, messageId })
	yield* drainPending()

	let id = ''
	const model = ''
	let textBuf = ''
	let finishReason: ChatCompletionResponse['finishReason'] = 'stop'
	let usage: ChatCompletionResponse['usage'] = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	const toolBuckets = new Map<
		number,
		{ id: string; name: string; argsBuf: string; started: boolean; completed: boolean }
	>()
	let streamError: string | undefined

	const stream = provider.chatStream({ ...params, stream: true }) as AsyncIterable<StreamChunk>

	try {
		for await (const chunk of stream) {
			if (chunk.error) {
				streamError = chunk.error
				break
			}
			if (!id && chunk.id) id = chunk.id

			if (chunk.delta.content) {
				textBuf += chunk.delta.content
				await emitEvent({
					type: 'text_delta',
					runId,
					iteration,
					messageId,
					text: chunk.delta.content,
				})
				yield* drainPending()
			}

			for (const tc of chunk.delta.toolCalls ?? []) {
				let bucket = toolBuckets.get(tc.index)
				if (!bucket) {
					bucket = {
						id: tc.id ?? '',
						name: tc.function?.name ?? '',
						argsBuf: '',
						started: false,
						completed: false,
					}
					toolBuckets.set(tc.index, bucket)
				}
				if (tc.id && !bucket.id) bucket.id = tc.id
				if (tc.function?.name && !bucket.name) bucket.name = tc.function.name

				if (!bucket.started && bucket.id && bucket.name) {
					bucket.started = true
					await emitEvent({
						type: 'tool_input_started',
						runId,
						iteration,
						messageId,
						toolUseId: bucket.id as ToolUseId,
						toolName: bucket.name,
					})
					yield* drainPending()
				}

				const fragment = tc.function?.arguments
				if (fragment) {
					if (!bucket.id) {
						log.warn('tool_input_delta arrived before tool id was known; dropping fragment', {
							runId,
							index: tc.index,
							length: fragment.length,
						})
					} else {
						bucket.argsBuf += fragment
						await emitEvent({
							type: 'tool_input_delta',
							runId,
							toolUseId: bucket.id as ToolUseId,
							partialJson: fragment,
						})
						yield* drainPending()
					}
				}
			}

			if (chunk.delta.toolCallEnd) {
				const { index, id: endId } = chunk.delta.toolCallEnd
				const bucket = toolBuckets.get(index)
				if (bucket && !bucket.completed) {
					bucket.completed = true
					let parsed: unknown = {}
					try {
						parsed = bucket.argsBuf ? JSON.parse(bucket.argsBuf) : {}
					} catch (err) {
						log.warn('tool input JSON parse failed at content_block_stop', {
							runId,
							toolUseId: endId,
							error: err instanceof Error ? err.message : String(err),
						})
					}
					await emitEvent({
						type: 'tool_input_completed',
						runId,
						toolUseId: endId as ToolUseId,
						input: parsed,
					})
					yield* drainPending()
				}
			}

			if (chunk.finishReason) finishReason = chunk.finishReason
			if (chunk.usage) usage = chunk.usage
		}
	} catch (err) {
		streamError = err instanceof Error ? err.message : String(err)
	}

	// Flush any tool buckets the provider failed to close (no toolCallEnd
	// arrived — defensive against providers that don't yet emit it).
	for (const bucket of toolBuckets.values()) {
		if (bucket.started && !bucket.completed) {
			bucket.completed = true
			let parsed: unknown = {}
			try {
				parsed = bucket.argsBuf ? JSON.parse(bucket.argsBuf) : {}
			} catch {
				// leave parsed = {}
			}
			await emitEvent({
				type: 'tool_input_completed',
				runId,
				toolUseId: bucket.id as ToolUseId,
				input: parsed,
			})
			yield* drainPending()
		}
	}

	const stopReason: MessageStopReason = streamError
		? 'refusal'
		: synthesizeMessageStopReason(finishReason, forceFinalize)

	await emitEvent({
		type: 'message_completed',
		runId,
		iteration,
		messageId,
		stopReason,
		usage,
		content: textBuf || undefined,
	})
	yield* drainPending()

	if (streamError) {
		throw new Error(`Provider stream error: ${streamError}`)
	}

	const toolCalls = [...toolBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, b]) => ({
			id: b.id,
			type: 'function' as const,
			function: { name: b.name, arguments: b.argsBuf },
		}))

	const response: ChatCompletionResponse = {
		id: id || messageId,
		model: model || params.model,
		message: {
			role: 'assistant',
			content: textBuf.length > 0 ? textBuf : null,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		},
		finishReason,
		usage,
	}
	return { response, messageId }
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
					const { response } = yield* streamProviderTurn(
						this.ctx.provider,
						{
							model,
							messages,
							tools: openAITools && openAITools.length > 0 ? openAITools : undefined,
							temperature: runConfig.temperature,
							maxTokens: runConfig.maxResponseTokens,
							cacheControl: { type: 'auto' },
						},
						this.ctx.emitEvent,
						this.ctx.drainPending,
						runMgr.id,
						iterationNum,
						forceFinalize,
						this.ctx.log,
					)

					runMgr.accumulateUsage(response.usage)

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

			const response = await collect(
				this.ctx.provider.chatStream({
					model,
					messages: finalMessages,
					temperature: this.ctx.runConfig.temperature,
					maxTokens: this.ctx.runConfig.maxResponseTokens,
					cacheControl: { type: 'auto' },
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
