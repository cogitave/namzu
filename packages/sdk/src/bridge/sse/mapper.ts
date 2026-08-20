import type { StreamEventType } from '../../contracts/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/events.js'

export interface MappedStreamEvent {
	wire: StreamEventType
	data: Record<string, unknown>
	/**
	 * The cursor a client resubscribes at, as `<runId>:<seq>`.
	 *
	 * Not a bare number, and the reason is structural: a parent's stream also
	 * carries its children's events, each numbered in its OWN run's log, so one
	 * scalar over a mixed stream would compare positions from two different
	 * sequences. The run id is what makes the position addressable — a client
	 * keeps one cursor per run id and sends the right one back.
	 *
	 * This is what an SSE `id:` line should carry, which is why it sits beside
	 * the payload rather than inside it: a framer writes it without having to
	 * understand what kind of event it is.
	 *
	 * Absent when the event is not recoverable — every ephemeral event, every
	 * event whose durable write failed, and every delegation-lifecycle event
	 * that never passed through the run's log at all. A client must not advance
	 * its cursor on one, and the absence is how it knows.
	 */
	id?: string
}

type EventTransform<K extends RunEvent['type']> = {
	wire: StreamEventType
	transform: (event: Extract<RunEvent, { type: K }>, runId: RunId) => Record<string, unknown>
} | null

const MAPPING: {
	[K in RunEvent['type']]: EventTransform<K>
} = {
	run_started: {
		wire: 'run.started',
		transform: (e, runId) => ({
			run_id: runId,
			system_prompt: e.systemPrompt ?? null,
		}),
	},

	iteration_started: {
		wire: 'iteration.started',
		transform: (e, runId) => ({ run_id: runId, iteration: e.iteration }),
	},

	// Named policies only, never the handler: the wire cannot carry a
	// function, and the names are what an operator watching a live run
	// needs in order to see supervision loosen.
	approval_policy_changed: {
		wire: 'approval_policy.changed',
		transform: (e, runId) => ({ run_id: runId, from: e.from, to: e.to, reason: e.reason }),
	},

	iteration_completed: {
		wire: 'iteration.completed',
		transform: (e, runId) => ({ run_id: runId, iteration: e.iteration }),
	},

	reasoning_started: {
		wire: 'reasoning.started',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			message_id: e.messageId,
			block_index: e.blockIndex,
			reasoning_type: e.reasoningType,
		}),
	},

	reasoning_delta: {
		wire: 'reasoning.delta',
		transform: (e, runId) => ({
			run_id: runId,
			message_id: e.messageId,
			block_index: e.blockIndex,
			text: e.text,
		}),
	},

	reasoning_completed: {
		wire: 'reasoning.completed',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			message_id: e.messageId,
			block_index: e.blockIndex,
			text: e.text,
			signed: e.signed,
		}),
	},

	guardrail_triggered: {
		wire: 'guardrail.triggered',
		transform: (e, runId) => ({
			run_id: runId,
			stage: e.stage,
			action: e.action,
			guardrail: e.guardrail,
			reason: e.reason,
		}),
	},

	// Declined, for the reason the a2a mapper gives: whole message bodies,
	// tool output included. A subscribed browser must not receive a frame
	// carrying the content a compaction just removed.
	compaction_shed: null,
	compaction_completed: {
		wire: 'compaction.completed',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			messages_before: e.messagesBefore,
			messages_after: e.messagesAfter,
			tokens_before: e.tokensBefore,
			tokens_after: e.tokensAfter,
			measured_by: e.measuredBy,
			context_window_tokens: e.contextWindowTokens,
			window_source: e.windowSource,
		}),
	},

	// Carried for the same reason its sibling is: a host that can show a user
	// context was dropped must also be able to show them it was not, because a
	// run continuing at full context is the state that ends in an opaque
	// provider rejection later.
	// Declined: it duplicates content already on the wire — the prompt a
	// consumer can read from the transcript — and a system prompt plus a
	// tool catalogue is large enough that streaming it per change would
	// dominate the stream it rides on.
	request_envelope: null,

	compaction_tool_results_cleared: {
		wire: 'compaction.tool_results_cleared',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			cleared_count: e.clearedCount,
			chars_reclaimed: e.charsReclaimed,
			reclaimed_tokens: e.reclaimedTokens,
			relief_was_enough: e.reliefWasEnough,
		}),
	},

	compaction_failed: {
		wire: 'compaction.failed',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			cause: e.cause,
			messages: e.messages,
			...(e.error !== undefined ? { error: e.error } : {}),
		}),
	},

	tool_executing: {
		wire: 'tool.executing',
		transform: (e, runId) => ({
			run_id: runId,
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
			input: e.input,
		}),
	},

	// Ephemeral, like text_delta: a live view wants it, the durable record
	// does not, and a chatty tool must not be able to bloat transcript.jsonl.
	tool_progress: {
		wire: 'tool.progress',
		transform: (e, runId) => ({
			run_id: runId,
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
			message: e.message,
			fraction: e.fraction,
		}),
	},

	// Same reason as `tool_progress`, for the other half of a run's wall
	// clock: a backoff can run for the better part of a minute, and without
	// this the client gets no event and no keepalive for its duration.
	provider_retry: {
		wire: 'provider.retry',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			attempt: e.attempt,
			max_retries: e.maxRetries,
			delay_ms: e.delayMs,
			code: e.code,
			status: e.status,
			server_directed: e.serverDirected,
		}),
	},

	provider_fallback: {
		wire: 'provider.fallback',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			from_index: e.fromIndex,
			from_provider_id: e.fromProviderId,
			from_model: e.fromModel,
			to_index: e.toIndex,
			to_provider_id: e.toProviderId,
			to_model: e.toModel,
			code: e.code,
			status: e.status,
			reason: e.reason,
		}),
	},

	user_question_asked: {
		wire: 'question.asked',
		transform: (e, runId) => ({
			run_id: runId,
			checkpoint_id: e.checkpointId,
			question_id: e.questionId,
			question: e.question,
		}),
	},

	user_question_answered: {
		wire: 'question.answered',
		transform: (e, runId) => ({
			run_id: runId,
			checkpoint_id: e.checkpointId,
			question_id: e.questionId ?? null,
			answered: e.answered,
		}),
	},

	tool_completed: {
		wire: 'tool.completed',
		transform: (e, runId) => ({
			run_id: runId,
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
			result: e.result,
			is_error: e.isError,
		}),
	},

	tool_review_requested: {
		wire: 'review.requested',
		transform: (e, runId) => ({
			run_id: runId,
			tool_calls: e.toolCalls,
			iteration: e.iteration,
		}),
	},

	tool_review_completed: {
		wire: 'review.completed',
		transform: (e, runId) => ({
			run_id: runId,
			decision: e.decision,
		}),
	},

	checkpoint_created: {
		wire: 'checkpoint.created',
		transform: (e, runId) => ({
			run_id: runId,
			checkpoint_id: e.checkpointId,
			iteration: e.iteration,
		}),
	},

	run_paused: {
		wire: 'run.paused',
		transform: (e, runId) => ({
			run_id: runId,
			checkpoint_id: e.checkpointId,
			reason: e.reason,
		}),
	},

	run_resuming: {
		wire: 'run.resuming',
		transform: (e, runId) => ({
			run_id: runId,
			from_checkpoint_id: e.fromCheckpointId,
		}),
	},

	token_usage_updated: {
		wire: 'token.usage',
		transform: (e, runId) => ({
			run_id: runId,
			usage: e.usage,
			cost: e.cost,
			// Carried, and named apart from `usage` on the wire as well as in
			// the type. A remote surface has exactly the same opportunity to
			// divide cumulative spend by a context window as a local one, and
			// no more information with which to notice.
			...(e.contextTokens !== undefined ? { context_tokens: e.contextTokens } : {}),
			...(e.contextMeasuredBy !== undefined ? { context_measured_by: e.contextMeasuredBy } : {}),
			...(e.contextWindowTokens !== undefined
				? { context_window_tokens: e.contextWindowTokens }
				: {}),
			...(e.windowSource !== undefined ? { window_source: e.windowSource } : {}),
		}),
	},

	activity_created: {
		wire: 'activity.created',
		transform: (e, runId) => ({
			run_id: runId,
			activity_id: e.activityId,
			activity_type: e.activityType,
			description: e.description,
		}),
	},

	activity_updated: {
		wire: 'activity.updated',
		transform: (e, runId) => ({
			run_id: runId,
			activity_id: e.activityId,
			status: e.status,
			output: e.output,
			error: e.error,
		}),
	},

	plan_ready: {
		wire: 'plan.ready',
		transform: (e, runId) => ({
			run_id: runId,
			plan_id: e.planId,
			title: e.title,
			steps: e.steps,
			summary: e.summary,
		}),
	},

	plan_approved: {
		wire: 'plan.approved',
		transform: (e, runId) => ({ run_id: runId, plan_id: e.planId }),
	},

	plan_rejected: {
		wire: 'plan.rejected',
		transform: (e, runId) => ({
			run_id: runId,
			plan_id: e.planId,
			reason: e.reason,
		}),
	},

	plan_completed: {
		wire: 'plan.completed',
		transform: (e, runId) => ({ run_id: runId, plan_id: e.planId }),
	},

	plan_failed: {
		wire: 'plan.failed',
		transform: (e, runId) => ({
			run_id: runId,
			plan_id: e.planId,
			reason: e.reason,
		}),
	},

	plan_step_updated: {
		wire: 'plan.step_updated',
		transform: (e, runId) => ({
			run_id: runId,
			plan_id: e.planId,
			step_id: e.stepId,
			status: e.status,
		}),
	},

	run_completed: null,
	run_failed: null,

	// Not mapped to a wire event yet — hosts consume `capability_warning`
	// from the RunEvent stream directly; promoting it to the SSE contract
	// needs a StreamEventType addition first.
	capability_warning: null,
	// Counts describing a local storage repair are likewise a RunEvent host
	// diagnostic, not yet part of the public SSE wire vocabulary.
	message_history_repaired: null,

	agent_pending: {
		wire: 'agent.pending',
		transform: (e, runId) => ({
			run_id: runId,
			task_id: e.taskId,
			parent_agent_id: e.parentAgentId,
			child_agent_id: e.childAgentId,
			depth: e.depth,
		}),
	},

	agent_completed: {
		wire: 'agent.completed',
		transform: (e, runId) => ({
			run_id: runId,
			task_id: e.taskId,
			result: e.result?.result,
		}),
	},

	agent_failed: {
		wire: 'agent.failed',
		transform: (e, runId) => ({
			run_id: runId,
			task_id: e.taskId,
			error: e.error,
		}),
	},

	agent_canceled: {
		wire: 'agent.canceled',
		transform: (e, runId) => ({
			run_id: runId,
			task_id: e.taskId,
		}),
	},

	task_created: {
		wire: 'task.created',
		transform: (e, runId) => ({
			run_id: runId,
			task_id: e.taskId,
			subject: e.subject,
			status: e.status,
		}),
	},

	task_updated: {
		wire: 'task.updated',
		transform: (e, runId) => ({
			run_id: runId,
			task_id: e.taskId,
			subject: e.subject,
			status: e.status,
			owner: e.owner ?? null,
		}),
	},

	plugin_hook_executing: {
		wire: 'plugin.hook_executing',
		transform: (e, runId) => ({
			run_id: runId,
			plugin_id: e.pluginId,
			hook_event: e.hookEvent,
		}),
	},

	plugin_hook_completed: {
		wire: 'plugin.hook_completed',
		transform: (e, runId) => ({
			run_id: runId,
			plugin_id: e.pluginId,
			hook_event: e.hookEvent,
			result_action: e.result.action,
		}),
	},

	sandbox_created: {
		wire: 'sandbox.created',
		transform: (e, runId) => ({
			run_id: runId,
			sandbox_id: e.sandboxId,
			environment: e.environment,
		}),
	},

	sandbox_exec: {
		wire: 'sandbox.exec',
		transform: (e, runId) => ({
			run_id: runId,
			sandbox_id: e.sandboxId,
			command: e.command,
			exit_code: e.exitCode,
			duration_ms: e.durationMs,
		}),
	},

	sandbox_destroyed: {
		wire: 'sandbox.destroyed',
		transform: (e, runId) => ({ run_id: runId, sandbox_id: e.sandboxId }),
	},

	// Sub-session lifecycle events (session-hierarchy.md §10.4). These are
	// in-flight signals carried on the kernel bus; the SSE wire surface does
	// not emit them today.
	subsession_spawned: null,
	subsession_messaged: null,
	subsession_idled: null,

	// v3 message + tool-input lifecycle (ses_001-tool-stream-events). Additive
	// today; the orchestrator does not yet emit these. Phase 4 of the
	// migration switches the orchestrator over and removes `llm_response`
	// from this map.
	message_started: {
		wire: 'message.created',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			message_id: e.messageId,
		}),
	},

	text_delta: {
		wire: 'message.delta',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			message_id: e.messageId,
			text: e.text,
		}),
	},

	message_completed: {
		wire: 'message.completed',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			message_id: e.messageId,
			stop_reason: e.stopReason,
			usage: e.usage ?? null,
		}),
	},

	tool_input_started: {
		wire: 'tool.input_started',
		transform: (e, runId) => ({
			run_id: runId,
			iteration: e.iteration,
			message_id: e.messageId,
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
		}),
	},

	tool_input_delta: {
		wire: 'tool.input_delta',
		transform: (e, runId) => ({
			run_id: runId,
			tool_use_id: e.toolUseId,
			partial_json: e.partialJson,
		}),
	},

	tool_input_completed: {
		wire: 'tool.input_completed',
		transform: (e, runId) => ({
			run_id: runId,
			tool_use_id: e.toolUseId,
			input: e.input,
		}),
	},
}

export function mapRunToStreamEvent(event: RunEvent, runId: RunId): MappedStreamEvent | null {
	const mapping = MAPPING[event.type]
	if (!mapping) return null

	const data = (mapping.transform as (event: RunEvent, runId: RunId) => Record<string, unknown>)(
		event,
		runId,
	)

	const annotated = event as unknown as Record<string, unknown>
	if ('sourceAgentId' in annotated && annotated.sourceAgentId) {
		data.source_agent_id = annotated.sourceAgentId
	}
	if ('parentTaskId' in annotated && annotated.parentTaskId) {
		data.parent_task_id = annotated.parentTaskId
	}

	// Keyed on the event's OWN run id, not the stream's. A child's event
	// arriving on a parent's stream is numbered in the child's log, so stamping
	// the enclosing run here would produce a cursor that addresses the wrong
	// sequence — and it would look right.
	return {
		wire: mapping.wire,
		data,
		...(event.seq !== undefined ? { id: `${event.runId}:${event.seq}` } : {}),
	}
}

/** @deprecated Use mapRunToStreamEvent */
export const mapSessionToStreamEvent = mapRunToStreamEvent
