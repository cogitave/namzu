import { GENAI, NAMZU } from '../constants/telemetry/index.js'
import type { SessionEvent, SessionEventListener, Turn } from '../types/session/index.js'
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

export interface TurnReporter {
	listener: SessionEventListener
	summary(turn: Turn): void
}

export function createTurnReporter(parentLogger?: Logger): TurnReporter {
	const log = resolveLogger(parentLogger).child({
		[SCOPE_ATTRIBUTE]: 'turn/reporter',
	})

	const listener: SessionEventListener = (event: SessionEvent) => {
		switch (event.type) {
			case 'turn_started':
				log.info('Turn started', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.turn.has_system_prompt': !!event.systemPrompt,
					'namzu.turn.system_prompt_length': event.systemPrompt?.length ?? 0,
				})
				break

			case 'approval_policy_changed':
				// `warn`, not `info`. Every change here is a change in how
				// closely this turn is supervised, and the one worth seeing in a
				// scrolling log is the loosening nobody meant to leave on.
				log.warn('Approval policy changed', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.approval.policy.from': event.from,
					'namzu.approval.policy.to': event.to,
					'namzu.approval.policy.reason': event.reason,
				})
				break

			case 'iteration_started':
				log.info('Iteration started', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
				})
				break

			case 'iteration_completed':
				log.info('Iteration completed', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.turn.has_tool_calls': event.hasToolCalls,
				})
				break

			case 'tool_executing':
				log.info('Tool executing', {
					[NAMZU.TURN_ID]: event.turnId,
					[GENAI.TOOL_NAME]: event.toolName,
				})
				break

			case 'tool_completed':
				log.info('Tool completed', {
					[NAMZU.TURN_ID]: event.turnId,
					[GENAI.TOOL_NAME]: event.toolName,
				})
				break

			case 'token_usage_updated':
				log.info('Token usage updated', {
					[NAMZU.TURN_ID]: event.turnId,
					[GENAI.USAGE_INPUT_TOKENS]: event.usage.promptTokens,
					[GENAI.USAGE_OUTPUT_TOKENS]: event.usage.completionTokens,
					'namzu.usage.total_tokens': event.usage.totalTokens,
					'namzu.turn.total_cost': event.cost.totalCost,
				})
				break

			case 'turn_completed':
				log.info('Turn completed', { [NAMZU.TURN_ID]: event.turnId })
				break

			case 'turn_failed':
				log.error('Turn failed', {
					[NAMZU.TURN_ID]: event.turnId,
					'exception.message': event.error,
					// A greppable id and a sentence saying what to change,
					// where before there was only whatever prose the vendor
					// SDK happened to write.
					'namzu.turn.code': event.failure?.code,
					'namzu.turn.reason': event.explanation?.id,
					'namzu.turn.hint': event.explanation?.hint,
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
			case 'turn_paused':
			case 'turn_resuming':
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
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.task.id': event.taskId,
					'namzu.turn.parent_agent_id': event.parentAgentId,
					'namzu.turn.child_agent_id': event.childAgentId,
					'namzu.agent.depth': event.depth,
				})
				break

			case 'agent_completed':
				log.info('Agent task completed', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.task.id': event.taskId,
					[NAMZU.TURN_STATUS]: event.result.status,
					'namzu.turn.iterations': event.result.iterations,
				})
				break

			case 'agent_failed':
				log.error('Agent task failed', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.task.id': event.taskId,
					'exception.message': event.error,
				})
				break

			case 'agent_canceled':
				log.info('Agent task canceled', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.task.id': event.taskId,
				})
				break

			case 'task_created':
				log.info('Task created', {
					'namzu.task.subject': event.subject,
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.task.id': event.taskId,
					[NAMZU.TURN_STATUS]: event.status,
				})
				break

			case 'task_updated':
				log.info('Task updated', {
					'namzu.task.subject': event.subject,
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.task.id': event.taskId,
					[NAMZU.TURN_STATUS]: event.status,
					'namzu.turn.owner': event.owner,
				})
				break

			case 'plugin_hook_executing':
				log.debug('Plugin hook executing', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.plugin.id': event.pluginId,
					'namzu.turn.hook_event': event.hookEvent,
				})
				break

			case 'plugin_hook_completed':
				log.debug('Plugin hook completed', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.plugin.id': event.pluginId,
					'namzu.turn.hook_event': event.hookEvent,
					'namzu.turn.action': event.result.action,
				})
				break

			case 'sandbox_created':
				log.info('Sandbox created', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.sandbox.id': event.sandboxId,
					'namzu.execution.environment': event.environment,
				})
				break

			case 'sandbox_exec':
				log.debug('Sandbox exec', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.sandbox.id': event.sandboxId,
					'namzu.turn.command': event.command,
					'namzu.turn.exit_code': event.exitCode,
					'namzu.duration_ms': event.durationMs,
				})
				break

			case 'sandbox_destroyed':
				log.info('Sandbox destroyed', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.sandbox.id': event.sandboxId,
				})
				break

			case 'child_session_spawned':
				log.debug('Sub-session spawned', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.session.child_id': event.childSessionId,
					[NAMZU.SESSION_ID]: event.sessionId,
					'namzu.agent.depth': event.lineage?.depth ?? 0,
				})
				break

			case 'child_session_messaged':
				log.debug('Sub-session message', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.session.child_id': event.childSessionId,
					[NAMZU.SESSION_ID]: event.sessionId,
					'namzu.turn.message_id': event.messageId,
					'namzu.agent.depth': event.lineage?.depth ?? 0,
				})
				break

			case 'child_session_idled':
				log.debug('Sub-session idled', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.session.child_id': event.childSessionId,
					[NAMZU.SESSION_ID]: event.sessionId,
					'namzu.agent.depth': event.lineage?.depth ?? 0,
				})
				break

			case 'reasoning_started':
			case 'reasoning_delta':
				// High-frequency and content-bearing; the completed block
				// below carries everything a log needs.
				break

			case 'reasoning_completed':
				log.debug('Reasoning block completed', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.turn.block_index': event.blockIndex,
					'namzu.turn.signed': event.signed,
					'namzu.turn.chars': event.text?.length ?? 0,
				})
				break

			case 'guardrail_triggered':
				log.warn('Guardrail triggered', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.turn.stage': event.stage,
					'namzu.turn.action': event.action,
					'namzu.guardrail.name': event.guardrail,
					'namzu.turn.reason': event.reason,
				})
				break

			case 'compaction_completed':
				log.info('Context compacted', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.turn.messages_dropped': event.messagesBefore - event.messagesAfter,
					'namzu.turn.tokens_before': event.tokensBefore,
					'namzu.turn.tokens_after': event.tokensAfter,
					'namzu.turn.measured_by': event.measuredBy,
					'namzu.turn.context_window_tokens': event.contextWindowTokens,
					'namzu.turn.window_source': event.windowSource,
				})
				break

			case 'request_envelope':
				// `debug`, not `info`. It fires only when something changed, so
				// it is never noise — but it carries a whole system prompt, and
				// a default-level start that printed one would bury everything
				// else the way the registry's `info` registrations did.
				log.debug('Request envelope changed', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.request.model': event.model,
					'namzu.request.tool_count': event.toolNames.length,
					'namzu.request.tool_schema_digest': event.toolSchemaDigest,
				})
				break

			case 'background_job_exited':
				log.info('Background job ended', {
					'namzu.jobs.id': event.jobId,
					'namzu.jobs.status': event.status,
					...(event.exitCode !== undefined ? { 'namzu.jobs.exit_code': event.exitCode } : {}),
				})
				break
			case 'memory_consolidated':
				log.info('Turn learnings consolidated into the memory store', {
					'namzu.memory.id': event.memoryId,
					'namzu.memory.decisions': event.decisions,
					'namzu.memory.discoveries': event.discoveries,
					'namzu.memory.failures': event.failures,
				})
				break
			case 'compaction_tool_results_cleared':
				// `info` on both branches. The relieved case is the turn
				// avoiding a summarization, which is good news worth stating;
				// the unrelieved case is the history taking two edits in one
				// pass, and a reader who saw only the `compaction_completed`
				// below would attribute the whole loss to it.
				// Namespaced, unlike its neighbours above. Those are the standing
				// inventory the `namespacedAttributeKeyViolationCount` ratchet
				// froze; NEW keys have no reason to join it, and adding six
				// would have moved a number LOG-22 exists to drive to zero.
				log.info('Cleared oversized tool results', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.compaction.cleared_count': event.clearedCount,
					'namzu.compaction.chars_reclaimed': event.charsReclaimed,
					'namzu.compaction.reclaimed_tokens': event.reclaimedTokens,
					'namzu.compaction.relief_was_enough': event.reliefWasEnough,
				})
				break

			case 'compaction_failed':
				// warn rather than info: the turn is now continuing at a context
				// size it had already decided was too large.
				log.warn('Context compaction shed nothing', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.turn.cause': event.cause,
					'namzu.turn.messages': event.messages,
					...(event.error !== undefined ? { 'exception.message': event.error } : {}),
				})
				break

			case 'capability_warning':
				log.warn('Provider capability mismatch', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.turn.capability': event.capability,
					[GENAI.SYSTEM]: event.providerId,
					'namzu.turn.message': event.message,
				})
				break

			case 'message_history_repaired':
				log.warn('Repaired provider-invalid conversation history', {
					[NAMZU.TURN_ID]: event.turnId,
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
				// are a live-view signal, not a turn milestone.
				log.debug('Tool progress', {
					[NAMZU.TURN_ID]: event.turnId,
					[GENAI.TOOL_NAME]: event.toolName,
					'namzu.turn.message': event.message,
				})
				break

			case 'user_question_asked':
				log.info('Question asked — the turn is parked on an answer', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.checkpoint.id': event.checkpointId,
					'namzu.turn.question_id': event.questionId,
				})
				break

			case 'user_question_answered':
				log.info(event.answered ? 'Question answered' : 'Question closed unanswered', {
					[NAMZU.TURN_ID]: event.turnId,
					'namzu.checkpoint.id': event.checkpointId,
				})
				break

			case 'provider_retry':
				// `warn`, not debug: this is the turn going quiet for a
				// measurable stretch, and the delay it names is still ahead.
				log.warn('Model call failed — retrying', {
					'namzu.provider.retry_delay_ms': event.delayMs,
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.retry.attempt': event.attempt,
					'namzu.turn.max_retries': event.maxRetries,
					'namzu.turn.code': event.code,
					[NAMZU.TURN_STATUS]: event.status,
					'namzu.turn.server_directed': event.serverDirected,
				})
				break

			case 'provider_fallback':
				// `warn` for the same reason as a retry, and one stronger: the rest
				// of this turn is being served by a provider the caller did not pick.
				log.warn('Provider could not serve — continuing on the fallback', {
					[NAMZU.TURN_ID]: event.turnId,
					[NAMZU.ITERATION]: event.iteration,
					'namzu.turn.from_index': event.fromIndex,
					'namzu.turn.from_provider_id': event.fromProviderId,
					'namzu.turn.from_model': event.fromModel,
					'namzu.turn.to_index': event.toIndex,
					'namzu.turn.to_provider_id': event.toProviderId,
					'namzu.turn.to_model': event.toModel,
					'namzu.turn.code': event.code,
					[NAMZU.TURN_STATUS]: event.status,
				})
				break

			case 'hosted_tool':
			case 'tool_calls_admitted':
			case 'compaction_shed':
				// Deliberately silent. The report is what a human reads about a
				// run; replaying every shed message into it would bury the
				// summary line that says the pass happened, in exactly the
				// content the pass existed to remove.
				break

			default: {
				const _exhaustive: never = event
				throw new Error(`Unhandled session event type: ${(_exhaustive as SessionEvent).type}`)
			}
		}
	}

	function summary(turn: Turn): void {
		const elapsed = (turn.endedAt ?? Date.now()) - turn.startedAt
		const { tokenUsage, costInfo, currentIteration, stopReason } = turn

		log.info('Turn summary', {
			[NAMZU.TURN_ID]: turn.id,
			'namzu.turn.agent': turn.metadata.agentName,
			[NAMZU.TURN_STATUS]: turn.status,
			'namzu.turn.stop_reason': stopReason ?? 'unknown',
			'namzu.turn.iterations': currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: tokenUsage.completionTokens,
			'namzu.usage.total_tokens': tokenUsage.totalTokens,
			'namzu.turn.cost': formatCost(costInfo.totalCost),
			'namzu.turn.duration': formatDuration(elapsed),
		})
	}

	return { listener, summary }
}
