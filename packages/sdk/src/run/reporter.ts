import { GENAI, NAMZU } from '../constants/telemetry/index.js'
import type { Run, RunEvent, RunEventListener } from '../types/run/index.js'
import { formatCost } from '../utils/cost.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
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
		[SCOPE_ATTRIBUTE]: 'run/reporter',
	})

	const listener: RunEventListener = (event: RunEvent) => {
		switch (event.type) {
			case 'run_started':
				log.info('Run started', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.run.has_system_prompt': !!event.systemPrompt,
					'namzu.run.system_prompt_length': event.systemPrompt?.length ?? 0,
				})
				break

			case 'approval_policy_changed':
				// `warn`, not `info`. Every change here is a change in how
				// closely this run is supervised, and the one worth seeing in a
				// scrolling log is the loosening nobody meant to leave on.
				log.warn('Approval policy changed', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.approval.policy.from': event.from,
					'namzu.approval.policy.to': event.to,
					'namzu.approval.policy.reason': event.reason,
				})
				break

			case 'iteration_started':
				log.info('Iteration started', {
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
				})
				break

			case 'iteration_completed':
				log.info('Iteration completed', {
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.run.has_tool_calls': event.hasToolCalls,
				})
				break

			case 'tool_executing':
				log.info('Tool executing', {
					[NAMZU.RUN_ID]: event.runId,
					[GENAI.TOOL_NAME]: event.toolName,
				})
				break

			case 'tool_completed':
				log.info('Tool completed', {
					[NAMZU.RUN_ID]: event.runId,
					[GENAI.TOOL_NAME]: event.toolName,
				})
				break

			case 'token_usage_updated':
				log.info('Token usage updated', {
					[NAMZU.RUN_ID]: event.runId,
					[GENAI.USAGE_INPUT_TOKENS]: event.usage.promptTokens,
					[GENAI.USAGE_OUTPUT_TOKENS]: event.usage.completionTokens,
					'namzu.usage.total_tokens': event.usage.totalTokens,
					'namzu.run.total_cost': event.cost.totalCost,
				})
				break

			case 'run_completed':
				log.info('Run completed', { [NAMZU.RUN_ID]: event.runId })
				break

			case 'run_failed':
				log.error('Run failed', {
					[NAMZU.RUN_ID]: event.runId,
					'exception.message': event.error,
					// A greppable id and a sentence saying what to change,
					// where before there was only whatever prose the vendor
					// SDK happened to write.
					'namzu.run.code': event.failure?.code,
					'namzu.run.reason': event.explanation?.id,
					'namzu.run.hint': event.explanation?.hint,
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
				log.info('Agent task pending', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.task.id': event.taskId,
					'namzu.run.parent_agent_id': event.parentAgentId,
					'namzu.run.child_agent_id': event.childAgentId,
					'namzu.agent.depth': event.depth,
				})
				break

			case 'agent_completed':
				log.info('Agent task completed', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.task.id': event.taskId,
					[NAMZU.RUN_STATUS]: event.result.status,
					'namzu.run.iterations': event.result.iterations,
				})
				break

			case 'agent_failed':
				log.error('Agent task failed', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.task.id': event.taskId,
					'exception.message': event.error,
				})
				break

			case 'agent_canceled':
				log.info('Agent task canceled', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.task.id': event.taskId,
				})
				break

			case 'task_created':
				log.info('Task created', {
					'namzu.task.subject': event.subject,
					[NAMZU.RUN_ID]: event.runId,
					'namzu.task.id': event.taskId,
					[NAMZU.RUN_STATUS]: event.status,
				})
				break

			case 'task_updated':
				log.info('Task updated', {
					'namzu.task.subject': event.subject,
					[NAMZU.RUN_ID]: event.runId,
					'namzu.task.id': event.taskId,
					[NAMZU.RUN_STATUS]: event.status,
					'namzu.run.owner': event.owner,
				})
				break

			case 'plugin_hook_executing':
				log.debug('Plugin hook executing', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.plugin.id': event.pluginId,
					'namzu.run.hook_event': event.hookEvent,
				})
				break

			case 'plugin_hook_completed':
				log.debug('Plugin hook completed', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.plugin.id': event.pluginId,
					'namzu.run.hook_event': event.hookEvent,
					'namzu.run.action': event.result.action,
				})
				break

			case 'sandbox_created':
				log.info('Sandbox created', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.sandbox.id': event.sandboxId,
					'namzu.execution.environment': event.environment,
				})
				break

			case 'sandbox_exec':
				log.debug('Sandbox exec', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.sandbox.id': event.sandboxId,
					'namzu.run.command': event.command,
					'namzu.run.exit_code': event.exitCode,
					'namzu.duration_ms': event.durationMs,
				})
				break

			case 'sandbox_destroyed':
				log.info('Sandbox destroyed', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.sandbox.id': event.sandboxId,
				})
				break

			case 'subsession_spawned':
				log.debug('Sub-session spawned', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.sub_session.id': event.subSessionId,
					'namzu.run.parent_session_id': event.parentSessionId,
					'namzu.agent.depth': event.lineage.depth,
				})
				break

			case 'subsession_messaged':
				log.debug('Sub-session message', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.sub_session.id': event.subSessionId,
					'namzu.run.parent_session_id': event.parentSessionId,
					'namzu.run.message_id': event.messageId,
					'namzu.agent.depth': event.lineage.depth,
				})
				break

			case 'subsession_idled':
				log.debug('Sub-session idled', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.sub_session.id': event.subSessionId,
					'namzu.run.parent_session_id': event.parentSessionId,
					'namzu.agent.depth': event.lineage.depth,
				})
				break

			case 'reasoning_started':
			case 'reasoning_delta':
				// High-frequency and content-bearing; the completed block
				// below carries everything a log needs.
				break

			case 'reasoning_completed':
				log.debug('Reasoning block completed', {
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.run.block_index': event.blockIndex,
					'namzu.run.signed': event.signed,
					'namzu.run.chars': event.text?.length ?? 0,
				})
				break

			case 'guardrail_triggered':
				log.warn('Guardrail triggered', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.run.stage': event.stage,
					'namzu.run.action': event.action,
					'namzu.guardrail.name': event.guardrail,
					'namzu.run.reason': event.reason,
				})
				break

			case 'compaction_completed':
				log.info('Context compacted', {
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.run.messages_dropped': event.messagesBefore - event.messagesAfter,
					'namzu.run.tokens_before': event.tokensBefore,
					'namzu.run.tokens_after': event.tokensAfter,
					'namzu.run.measured_by': event.measuredBy,
					'namzu.run.context_window_tokens': event.contextWindowTokens,
					'namzu.run.window_source': event.windowSource,
				})
				break

			case 'request_envelope':
				// `debug`, not `info`. It fires only when something changed, so
				// it is never noise — but it carries a whole system prompt, and
				// a default-level start that printed one would bury everything
				// else the way the registry's `info` registrations did.
				log.debug('Request envelope changed', {
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.request.model': event.model,
					'namzu.request.tool_count': event.toolNames.length,
					'namzu.request.tool_schema_digest': event.toolSchemaDigest,
				})
				break

			case 'memory_consolidated':
				log.info('Run learnings consolidated into the memory store', {
					'namzu.memory.id': event.memoryId,
					'namzu.memory.decisions': event.decisions,
					'namzu.memory.discoveries': event.discoveries,
					'namzu.memory.failures': event.failures,
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
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
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
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.run.cause': event.cause,
					'namzu.run.messages': event.messages,
					...(event.error !== undefined ? { 'exception.message': event.error } : {}),
				})
				break

			case 'capability_warning':
				log.warn('Provider capability mismatch', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.run.capability': event.capability,
					[GENAI.SYSTEM]: event.providerId,
					'namzu.run.message': event.message,
				})
				break

			case 'message_history_repaired':
				log.warn('Repaired provider-invalid conversation history', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.history.source': event.source,
					'namzu.history.duplicate_tool_results_removed': event.duplicateToolResultsRemoved,
					'namzu.history.orphaned_tool_results_removed': event.orphanedToolResultsRemoved,
					'namzu.history.synthetic_tool_results_inserted': event.syntheticToolResultsInserted,
					...(event.providerRejectedImagesSuppressed !== undefined
						? {
								'namzu.history.provider_rejected_images_suppressed':
									event.providerRejectedImagesSuppressed,
							}
						: {}),
				})
				break

			case 'tool_progress':
				// Debug, not info: a long tool can emit many of these and they
				// are a live-view signal, not a run milestone.
				log.debug('Tool progress', {
					[NAMZU.RUN_ID]: event.runId,
					[GENAI.TOOL_NAME]: event.toolName,
					'namzu.run.message': event.message,
				})
				break

			case 'user_question_asked':
				log.info('Question asked — the run is parked on an answer', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.checkpoint.id': event.checkpointId,
					'namzu.run.question_id': event.questionId,
				})
				break

			case 'user_question_answered':
				log.info(event.answered ? 'Question answered' : 'Question closed unanswered', {
					[NAMZU.RUN_ID]: event.runId,
					'namzu.checkpoint.id': event.checkpointId,
				})
				break

			case 'provider_retry':
				// `warn`, not debug: this is the run going quiet for a
				// measurable stretch, and the delay it names is still ahead.
				log.warn('Model call failed — retrying', {
					'namzu.provider.retry_delay_ms': event.delayMs,
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.retry.attempt': event.attempt,
					'namzu.run.max_retries': event.maxRetries,
					'namzu.run.code': event.code,
					[NAMZU.RUN_STATUS]: event.status,
					'namzu.run.server_directed': event.serverDirected,
				})
				break

			case 'provider_fallback':
				// `warn` for the same reason as a retry, and one stronger: the rest
				// of this run is being served by a provider the caller did not pick.
				log.warn('Provider could not serve — continuing on the fallback', {
					[NAMZU.RUN_ID]: event.runId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.run.from_index': event.fromIndex,
					'namzu.run.from_provider_id': event.fromProviderId,
					'namzu.run.from_model': event.fromModel,
					'namzu.run.to_index': event.toIndex,
					'namzu.run.to_provider_id': event.toProviderId,
					'namzu.run.to_model': event.toModel,
					'namzu.run.code': event.code,
					[NAMZU.RUN_STATUS]: event.status,
				})
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
			[NAMZU.RUN_ID]: run.id,
			'namzu.run.agent': run.metadata.agentName,
			[NAMZU.RUN_STATUS]: run.status,
			'namzu.run.stop_reason': stopReason ?? 'unknown',
			'namzu.run.iterations': currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: tokenUsage.completionTokens,
			'namzu.usage.total_tokens': tokenUsage.totalTokens,
			'namzu.run.cost': formatCost(costInfo.totalCost),
			'namzu.run.duration': formatDuration(elapsed),
		})
	}

	return { listener, summary }
}
