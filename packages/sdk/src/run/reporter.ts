import type { Run, RunEvent, RunEventListener } from '../types/run/index.js'
import { formatCost } from '../utils/cost.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	return `${minutes}m ${remainingSeconds}s`
}

export interface RunReporter {
	listener: RunEventListener
	summary(run: Run): void
}

export function createRunReporter(parentLogger?: Logger): RunReporter {
	const log = resolveLogger(parentLogger).child({
		component: 'RunReporter',
	})

	const listener: RunEventListener = (event: RunEvent) => {
		switch (event.type) {
			case 'run_started':
				log.info('Run started', {
					runId: event.runId,
					hasSystemPrompt: !!event.systemPrompt,
					systemPromptLength: event.systemPrompt?.length ?? 0,
				})
				break

			case 'iteration_started':
				log.info(`Iteration ${event.iteration} started`, {
					runId: event.runId,
					iteration: event.iteration,
				})
				break

			case 'iteration_completed':
				log.info(`Iteration ${event.iteration} completed`, {
					runId: event.runId,
					iteration: event.iteration,
					hasToolCalls: event.hasToolCalls,
				})
				break

			case 'tool_executing':
				log.info(`Tool executing: ${event.toolName}`, {
					runId: event.runId,
					tool: event.toolName,
				})
				break

			case 'tool_completed':
				log.info(`Tool completed: ${event.toolName}`, {
					runId: event.runId,
					tool: event.toolName,
				})
				break

			case 'token_usage_updated':
				log.info('Token usage updated', {
					runId: event.runId,
					promptTokens: event.usage.promptTokens,
					completionTokens: event.usage.completionTokens,
					totalTokens: event.usage.totalTokens,
					totalCost: event.cost.totalCost,
				})
				break

			case 'run_completed':
				log.info('Run completed', { runId: event.runId })
				break

			case 'run_failed':
				log.error('Run failed', {
					runId: event.runId,
					error: event.error,
					// A greppable id and a sentence saying what to change,
					// where before there was only whatever prose the vendor
					// SDK happened to write.
					code: event.failure?.code,
					reason: event.explanation?.id,
					hint: event.explanation?.hint,
				})
				break

			case 'activity_created':
			case 'activity_updated':
			case 'plan_ready':
			case 'plan_approved':
			case 'plan_rejected':
			case 'plan_step_updated':
			case 'plan_completed':
			case 'plan_failed':
			case 'tool_review_requested':
			case 'tool_review_completed':
			case 'checkpoint_created':
			case 'run_paused':
			case 'run_resuming':
			// v3 message + tool-input lifecycle (ses_001-tool-stream-events).
			// The reporter is a debug log surface; per-delta lines would be
			// too noisy. Phase 4 may add structured logging at the
			// message_completed boundary if signal proves useful.
			case 'message_started':
			case 'text_delta':
			case 'message_completed':
			case 'tool_input_started':
			case 'tool_input_delta':
			case 'tool_input_completed':
				break

			case 'agent_pending':
				log.info(`Agent task pending: ${event.childAgentId}`, {
					runId: event.runId,
					taskId: event.taskId,
					parentAgentId: event.parentAgentId,
					childAgentId: event.childAgentId,
					depth: event.depth,
				})
				break

			case 'agent_completed':
				log.info('Agent task completed', {
					runId: event.runId,
					taskId: event.taskId,
					status: event.result.status,
					iterations: event.result.iterations,
				})
				break

			case 'agent_failed':
				log.error('Agent task failed', {
					runId: event.runId,
					taskId: event.taskId,
					error: event.error,
				})
				break

			case 'agent_canceled':
				log.info('Agent task canceled', {
					runId: event.runId,
					taskId: event.taskId,
				})
				break

			case 'task_created':
				log.info(`Task created: ${event.subject}`, {
					runId: event.runId,
					taskId: event.taskId,
					status: event.status,
				})
				break

			case 'task_updated':
				log.info(`Task updated: ${event.subject}`, {
					runId: event.runId,
					taskId: event.taskId,
					status: event.status,
					owner: event.owner,
				})
				break

			case 'plugin_hook_executing':
				log.debug('Plugin hook executing', {
					runId: event.runId,
					pluginId: event.pluginId,
					hookEvent: event.hookEvent,
				})
				break

			case 'plugin_hook_completed':
				log.debug('Plugin hook completed', {
					runId: event.runId,
					pluginId: event.pluginId,
					hookEvent: event.hookEvent,
					action: event.result.action,
				})
				break

			case 'sandbox_created':
				log.info('Sandbox created', {
					runId: event.runId,
					sandboxId: event.sandboxId,
					environment: event.environment,
				})
				break

			case 'sandbox_exec':
				log.debug('Sandbox exec', {
					runId: event.runId,
					sandboxId: event.sandboxId,
					command: event.command,
					exitCode: event.exitCode,
					durationMs: event.durationMs,
				})
				break

			case 'sandbox_destroyed':
				log.info('Sandbox destroyed', {
					runId: event.runId,
					sandboxId: event.sandboxId,
				})
				break

			case 'subsession_spawned':
				log.debug('Sub-session spawned', {
					runId: event.runId,
					subSessionId: event.subSessionId,
					parentSessionId: event.parentSessionId,
					depth: event.lineage.depth,
				})
				break

			case 'subsession_messaged':
				log.debug('Sub-session message', {
					runId: event.runId,
					subSessionId: event.subSessionId,
					parentSessionId: event.parentSessionId,
					messageId: event.messageId,
					depth: event.lineage.depth,
				})
				break

			case 'subsession_idled':
				log.debug('Sub-session idled', {
					runId: event.runId,
					subSessionId: event.subSessionId,
					parentSessionId: event.parentSessionId,
					depth: event.lineage.depth,
				})
				break

			case 'reasoning_started':
			case 'reasoning_delta':
				// High-frequency and content-bearing; the completed block
				// below carries everything a log needs.
				break

			case 'reasoning_completed':
				log.debug('Reasoning block completed', {
					runId: event.runId,
					iteration: event.iteration,
					blockIndex: event.blockIndex,
					signed: event.signed,
					chars: event.text?.length ?? 0,
				})
				break

			case 'guardrail_triggered':
				log.warn('Guardrail triggered', {
					runId: event.runId,
					stage: event.stage,
					action: event.action,
					guardrail: event.guardrail,
					reason: event.reason,
				})
				break

			case 'compaction_completed':
				log.info('Context compacted', {
					runId: event.runId,
					iteration: event.iteration,
					messagesDropped: event.messagesBefore - event.messagesAfter,
					tokensBefore: event.tokensBefore,
					tokensAfter: event.tokensAfter,
					measuredBy: event.measuredBy,
					contextWindowTokens: event.contextWindowTokens,
					windowSource: event.windowSource,
				})
				break

			case 'request_envelope':
				// `debug`, not `info`. It fires only when something changed, so
				// it is never noise — but it carries a whole system prompt, and
				// a default-level start that printed one would bury everything
				// else the way the registry's `info` registrations did.
				log.debug('Request envelope changed', {
					'namzu.run.id': event.runId,
					'namzu.iteration': event.iteration,
					'namzu.request.model': event.model,
					'namzu.request.tool_count': event.toolNames.length,
					'namzu.request.tool_schema_digest': event.toolSchemaDigest,
				})
				break

			case 'compaction_tool_results_cleared':
				// `info` on both branches. The relieved case is the run
				// avoiding a summarization, which is good news worth stating;
				// the unrelieved case is the history taking two edits in one
				// pass, and a reader who saw only the `compaction_completed`
				// below would attribute the whole loss to it.
				// Namespaced, unlike its neighbours above. Those are the standing
				// inventory the `namespacedAttributeKeyViolationCount` ratchet
				// froze; NEW keys have no reason to join it, and adding six
				// would have moved a number LOG-22 exists to drive to zero.
				log.info('Cleared oversized tool results', {
					'namzu.run.id': event.runId,
					'namzu.iteration': event.iteration,
					'namzu.compaction.cleared_count': event.clearedCount,
					'namzu.compaction.chars_reclaimed': event.charsReclaimed,
					'namzu.compaction.reclaimed_tokens': event.reclaimedTokens,
					'namzu.compaction.relief_was_enough': event.reliefWasEnough,
				})
				break

			case 'compaction_failed':
				// warn rather than info: the run is now continuing at a context
				// size it had already decided was too large.
				log.warn('Context compaction shed nothing', {
					runId: event.runId,
					iteration: event.iteration,
					cause: event.cause,
					messages: event.messages,
					...(event.error !== undefined ? { error: event.error } : {}),
				})
				break

			case 'capability_warning':
				log.warn('Provider capability mismatch', {
					runId: event.runId,
					capability: event.capability,
					providerId: event.providerId,
					message: event.message,
				})
				break

			case 'tool_progress':
				// Debug, not info: a long tool can emit many of these and they
				// are a live-view signal, not a run milestone.
				log.debug(`Tool progress: ${event.toolName}`, {
					runId: event.runId,
					tool: event.toolName,
					message: event.message,
				})
				break

			case 'user_question_asked':
				log.info('Question asked — the run is parked on an answer', {
					runId: event.runId,
					checkpointId: event.checkpointId,
					questionId: event.questionId,
				})
				break

			case 'user_question_answered':
				log.info(event.answered ? 'Question answered' : 'Question closed unanswered', {
					runId: event.runId,
					checkpointId: event.checkpointId,
				})
				break

			case 'provider_retry':
				// `warn`, not debug: this is the run going quiet for a
				// measurable stretch, and the delay it names is still ahead.
				log.warn(`Model call failed — retrying in ${event.delayMs}ms`, {
					runId: event.runId,
					iteration: event.iteration,
					attempt: event.attempt,
					maxRetries: event.maxRetries,
					code: event.code,
					status: event.status,
					serverDirected: event.serverDirected,
				})
				break

			case 'provider_fallback':
				// `warn` for the same reason as a retry, and one stronger: the rest
				// of this run is being served by a provider the caller did not pick.
				log.warn(
					`Provider ${event.fromProviderId} could not serve — continuing on ${event.toProviderId}`,
					{
						runId: event.runId,
						iteration: event.iteration,
						fromIndex: event.fromIndex,
						fromProviderId: event.fromProviderId,
						fromModel: event.fromModel,
						toIndex: event.toIndex,
						toProviderId: event.toProviderId,
						toModel: event.toModel,
						code: event.code,
						status: event.status,
					},
				)
				break

			case 'compaction_shed':
				// Deliberately silent. The report is what a human reads about a
				// run; replaying every shed message into it would bury the
				// summary line that says the pass happened, in exactly the
				// content the pass existed to remove.
				break

			default: {
				const _exhaustive: never = event
				throw new Error(`Unhandled run event type: ${(_exhaustive as RunEvent).type}`)
			}
		}
	}

	function summary(run: Run): void {
		const elapsed = (run.endedAt ?? Date.now()) - run.startedAt
		const { tokenUsage, costInfo, currentIteration, stopReason } = run

		log.info('Run summary', {
			runId: run.id,
			agent: run.metadata.agentName,
			status: run.status,
			stopReason: stopReason ?? 'unknown',
			iterations: currentIteration,
			promptTokens: tokenUsage.promptTokens,
			completionTokens: tokenUsage.completionTokens,
			totalTokens: tokenUsage.totalTokens,
			cost: formatCost(costInfo.totalCost),
			duration: formatDuration(elapsed),
		})
	}

	return { listener, summary }
}
