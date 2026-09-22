import type { SessionStreamEventType } from '../../contracts/session/api.js'
import type { SessionEvent } from '../../types/session/events.js'

export interface MappedStreamEvent {
	wire: SessionStreamEventType
	data: Record<string, unknown>
	/**
	 * The cursor a client resubscribes at, as `<sessionId>:<seq>`.
	 *
	 * Not a bare number, and the reason is structural: a parent's stream also
	 * carries its children's events, each numbered in its OWN session's log, so
	 * one scalar over a mixed stream would compare positions from two different
	 * sequences. The session id is what makes the position addressable — a
	 * client keeps one cursor per session id and sends the right one back.
	 *
	 * This is what an SSE `id:` line should carry, which is why it sits beside
	 * the payload rather than inside it: a framer writes it without having to
	 * understand what kind of event it is.
	 *
	 * Absent when the event is not recoverable — every ephemeral event, every
	 * event whose durable write failed, and every delegation-lifecycle event
	 * that never passed through the session's log at all. A client must not advance
	 * its cursor on one, and the absence is how it knows.
	 */
	id?: string
}

/**
 * One event's wire name and payload. The payload holds the event's own
 * fields only: `session_id` and `turn_id` are stamped on every payload by
 * {@link mapSessionEventToStreamEvent}, from the event itself.
 */
type EventTransform<K extends SessionEvent['type']> = {
	wire: SessionStreamEventType
	transform: (event: Extract<SessionEvent, { type: K }>) => Record<string, unknown>
} | null

const MAPPING: {
	[K in SessionEvent['type']]: EventTransform<K>
} = {
	// Internal cumulative admission ledger, not a public UI event.
	tool_calls_admitted: null,
	hosted_tool: {
		wire: 'hosted.tool',
		transform: (e) => ({
			iteration: e.iteration,
			tool: e.tool,
		}),
	},
	turn_started: {
		wire: 'turn.started',
		transform: (e) => ({
			system_prompt: e.systemPrompt ?? null,
		}),
	},

	iteration_started: {
		wire: 'iteration.started',
		transform: (e) => ({ iteration: e.iteration }),
	},

	// Named policies only, never the handler: the wire cannot carry a
	// function, and the names are what an operator watching a live turn
	// needs in order to see supervision loosen.
	approval_policy_changed: {
		wire: 'approval_policy.changed',
		transform: (e) => ({
			from: e.from,
			to: e.to,
			reason: e.reason,
		}),
	},

	iteration_completed: {
		wire: 'iteration.completed',
		transform: (e) => ({ iteration: e.iteration }),
	},

	reasoning_started: {
		wire: 'reasoning.started',
		transform: (e) => ({
			iteration: e.iteration,
			message_id: e.messageId,
			block_index: e.blockIndex,
			reasoning_type: e.reasoningType,
		}),
	},

	reasoning_delta: {
		wire: 'reasoning.delta',
		transform: (e) => ({
			message_id: e.messageId,
			block_index: e.blockIndex,
			text: e.text,
		}),
	},

	reasoning_completed: {
		wire: 'reasoning.completed',
		transform: (e) => ({
			iteration: e.iteration,
			message_id: e.messageId,
			block_index: e.blockIndex,
			text: e.text,
			signed: e.signed,
		}),
	},

	guardrail_triggered: {
		wire: 'guardrail.triggered',
		transform: (e) => ({
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
		transform: (e) => ({
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
	// turn continuing at full context is the state that ends in an opaque
	// provider rejection later.
	// Declined: it duplicates content already on the wire — the prompt a
	// consumer can read from the transcript — and a system prompt plus a
	// tool catalogue is large enough that streaming it per change would
	// dominate the stream it rides on.
	request_envelope: null,

	background_job_exited: {
		wire: 'background_job.exited',
		transform: (e) => ({
			job_id: e.jobId,
			command: e.command,
			status: e.status,
			...(e.exitCode !== undefined ? { exit_code: e.exitCode } : {}),
			...(e.signal ? { signal: e.signal } : {}),
		}),
	},
	memory_consolidated: {
		wire: 'memory.consolidated',
		transform: (e) => ({
			memory_id: e.memoryId,
			title: e.title,
			decisions: e.decisions,
			discoveries: e.discoveries,
			failures: e.failures,
		}),
	},
	compaction_tool_results_cleared: {
		wire: 'compaction.tool_results_cleared',
		transform: (e) => ({
			iteration: e.iteration,
			cleared_count: e.clearedCount,
			chars_reclaimed: e.charsReclaimed,
			reclaimed_tokens: e.reclaimedTokens,
			relief_was_enough: e.reliefWasEnough,
		}),
	},

	compaction_failed: {
		wire: 'compaction.failed',
		transform: (e) => ({
			iteration: e.iteration,
			cause: e.cause,
			messages: e.messages,
			...(e.error !== undefined ? { error: e.error } : {}),
		}),
	},

	tool_executing: {
		wire: 'tool.executing',
		transform: (e) => ({
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
			input: e.input,
		}),
	},

	// Ephemeral, like text_delta: a live view wants it, the durable record
	// does not, and a chatty tool must not be able to bloat the session log.
	tool_progress: {
		wire: 'tool.progress',
		transform: (e) => ({
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
			message: e.message,
			fraction: e.fraction,
		}),
	},

	// Same reason as `tool_progress`, for the other half of a turn's wall
	// clock: a backoff can run for the better part of a minute, and without
	// this the client gets no event and no keepalive for its duration.
	provider_retry: {
		wire: 'provider.retry',
		transform: (e) => ({
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
		transform: (e) => ({
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
		transform: (e) => ({
			checkpoint_id: e.checkpointId,
			question_id: e.questionId,
			question: e.question,
		}),
	},

	user_question_answered: {
		wire: 'question.answered',
		transform: (e) => ({
			checkpoint_id: e.checkpointId,
			question_id: e.questionId ?? null,
			answered: e.answered,
		}),
	},

	tool_completed: {
		wire: 'tool.completed',
		transform: (e) => ({
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
			result: e.result,
			is_error: e.isError,
		}),
	},

	tool_review_requested: {
		wire: 'review.requested',
		transform: (e) => ({
			tool_calls: e.toolCalls,
			iteration: e.iteration,
		}),
	},

	tool_review_completed: {
		wire: 'review.completed',
		transform: (e) => ({
			decision: e.decision,
		}),
	},

	checkpoint_created: {
		wire: 'checkpoint.created',
		transform: (e) => ({
			checkpoint_id: e.checkpointId,
			iteration: e.iteration,
		}),
	},

	turn_paused: {
		wire: 'turn.paused',
		transform: (e) => ({
			checkpoint_id: e.checkpointId,
			reason: e.reason,
			...(e.failure ? { failure: e.failure } : {}),
			...(e.providerError ? { provider_error: e.providerError } : {}),
			...(e.explanation ? { explanation: e.explanation } : {}),
		}),
	},

	turn_resuming: {
		wire: 'turn.resuming',
		transform: (e) => ({
			from_checkpoint_id: e.fromCheckpointId,
		}),
	},

	token_usage_updated: {
		wire: 'token.usage',
		transform: (e) => ({
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
		transform: (e) => ({
			activity_id: e.activityId,
			activity_type: e.activityType,
			description: e.description,
		}),
	},

	activity_updated: {
		wire: 'activity.updated',
		transform: (e) => ({
			activity_id: e.activityId,
			status: e.status,
			output: e.output,
			error: e.error,
		}),
	},

	plan_ready: {
		wire: 'plan.ready',
		transform: (e) => ({
			plan_id: e.planId,
			title: e.title,
			steps: e.steps,
			summary: e.summary,
		}),
	},

	plan_approved: {
		wire: 'plan.approved',
		transform: (e) => ({ plan_id: e.planId }),
	},

	plan_rejected: {
		wire: 'plan.rejected',
		transform: (e) => ({
			plan_id: e.planId,
			reason: e.reason,
		}),
	},

	plan_completed: {
		wire: 'plan.completed',
		transform: (e) => ({ plan_id: e.planId }),
	},

	plan_failed: {
		wire: 'plan.failed',
		transform: (e) => ({
			plan_id: e.planId,
			reason: e.reason,
		}),
	},

	plan_step_updated: {
		wire: 'plan.step_updated',
		transform: (e) => ({
			plan_id: e.planId,
			step_id: e.stepId,
			status: e.status,
		}),
	},

	// The host that serves the stream writes `turn.completed`, `turn.failed`
	// and `turn.cancelled` from the settled turn, with the wire status and
	// usage it reports for it. Mapping the events too would put two terminal
	// frames on one stream.
	turn_completed: null,
	turn_failed: null,

	// Not mapped to a wire event yet — hosts consume `capability_warning`
	// from the SessionEvent stream directly; promoting it to the SSE contract
	// needs a SessionStreamEventType addition first.
	capability_warning: null,
	// Counts describing a local storage repair are likewise a SessionEvent host
	// diagnostic, not yet part of the public SSE wire vocabulary.
	message_history_repaired: null,

	agent_pending: {
		wire: 'agent.pending',
		transform: (e) => ({
			task_id: e.taskId,
			parent_agent_id: e.parentAgentId,
			child_agent_id: e.childAgentId,
			depth: e.depth,
			...(e.planId ? { plan_id: e.planId } : {}),
			...(e.planStepId ? { plan_step_id: e.planStepId } : {}),
			// Display grouping, so a remote consumer can rebuild the tree the
			// operator sees instead of a flat list of children. These fields are
			// display annotations only; they do not create dependencies,
			// barriers, or serial execution — `plan_id`/`plan_step_id` above are
			// the correlation a consumer may act on. Spread conditionally: this
			// transform is an allowlist, and a key that is always present would
			// tell a consumer a host had grouped work when it had not.
			...(e.workflow ? { workflow: e.workflow } : {}),
			...(e.phase ? { phase: e.phase } : {}),
			...(e.phaseDetail ? { phase_detail: e.phaseDetail } : {}),
			...(e.phaseOrder !== undefined ? { phase_order: e.phaseOrder } : {}),
		}),
	},

	agent_completed: {
		wire: 'agent.completed',
		transform: (e) => ({
			task_id: e.taskId,
			result: e.result?.result,
		}),
	},

	agent_failed: {
		wire: 'agent.failed',
		transform: (e) => ({
			task_id: e.taskId,
			error: e.error,
		}),
	},

	agent_canceled: {
		wire: 'agent.canceled',
		transform: (e) => ({
			task_id: e.taskId,
		}),
	},

	task_created: {
		wire: 'task.created',
		transform: (e) => ({
			task_id: e.taskId,
			subject: e.subject,
			status: e.status,
		}),
	},

	task_updated: {
		wire: 'task.updated',
		transform: (e) => ({
			task_id: e.taskId,
			subject: e.subject,
			status: e.status,
			owner: e.owner ?? null,
			...(e.deleted ? { deleted: true } : {}),
		}),
	},

	plugin_hook_executing: {
		wire: 'plugin.hook_executing',
		transform: (e) => ({
			plugin_id: e.pluginId,
			hook_event: e.hookEvent,
		}),
	},

	plugin_hook_completed: {
		wire: 'plugin.hook_completed',
		transform: (e) => ({
			plugin_id: e.pluginId,
			hook_event: e.hookEvent,
			result_action: e.result.action,
		}),
	},

	sandbox_created: {
		wire: 'sandbox.created',
		transform: (e) => ({
			sandbox_id: e.sandboxId,
			environment: e.environment,
		}),
	},

	sandbox_exec: {
		wire: 'sandbox.exec',
		transform: (e) => ({
			sandbox_id: e.sandboxId,
			command: e.command,
			exit_code: e.exitCode,
			duration_ms: e.durationMs,
		}),
	},

	sandbox_destroyed: {
		wire: 'sandbox.destroyed',
		transform: (e) => ({ sandbox_id: e.sandboxId }),
	},

	// Child-session lifecycle events. The parent's log records them, and a
	// client learns about delegated work from `agent.pending` and its siblings;
	// the SSE wire surface does not emit these today.
	child_session_spawned: null,
	child_session_messaged: null,
	child_session_idled: null,

	// v3 message + tool-input lifecycle (ses_001-tool-stream-events). Additive
	// today; the orchestrator does not yet emit these. Phase 4 of the
	// migration switches the orchestrator over and removes `llm_response`
	// from this map.
	message_started: {
		wire: 'message.created',
		transform: (e) => ({
			iteration: e.iteration,
			message_id: e.messageId,
		}),
	},

	text_delta: {
		wire: 'message.delta',
		transform: (e) => ({
			iteration: e.iteration,
			message_id: e.messageId,
			text: e.text,
		}),
	},

	message_completed: {
		wire: 'message.completed',
		transform: (e) => ({
			iteration: e.iteration,
			message_id: e.messageId,
			stop_reason: e.stopReason,
			usage: e.usage ?? null,
		}),
	},

	tool_input_started: {
		wire: 'tool.input_started',
		transform: (e) => ({
			iteration: e.iteration,
			message_id: e.messageId,
			tool_use_id: e.toolUseId,
			tool_name: e.toolName,
		}),
	},

	tool_input_delta: {
		wire: 'tool.input_delta',
		transform: (e) => ({
			tool_use_id: e.toolUseId,
			partial_json: e.partialJson,
		}),
	},

	tool_input_completed: {
		wire: 'tool.input_completed',
		transform: (e) => ({
			tool_use_id: e.toolUseId,
			input: e.input,
		}),
	},
}

/**
 * One session event as an SSE frame, or `null` for an event the wire does not
 * carry.
 *
 * Every payload names the session the event belongs to (`session_id`) and,
 * when it happened inside a turn, the turn (`turn_id`). Both come from the
 * event itself, so a child session's event relayed on its parent's stream
 * names the child, which is the session whose log numbers it.
 */
export function mapSessionEventToStreamEvent(event: SessionEvent): MappedStreamEvent | null {
	const mapping = MAPPING[event.type]
	if (!mapping) return null

	const data: Record<string, unknown> = {
		session_id: event.sessionId,
		...(event.turnId !== undefined ? { turn_id: event.turnId } : {}),
		...(mapping.transform as (event: SessionEvent) => Record<string, unknown>)(event),
	}

	const annotated = event as unknown as Record<string, unknown>
	if ('sourceAgentId' in annotated && annotated.sourceAgentId) {
		data.source_agent_id = annotated.sourceAgentId
	}
	if ('parentTaskId' in annotated && annotated.parentTaskId) {
		data.parent_task_id = annotated.parentTaskId
	}

	// Keyed on the event's OWN session, not the stream's. A child's event
	// arriving on a parent's stream is numbered in the child's log, so the
	// parent's id here would produce a cursor that addresses the wrong
	// sequence — and it would look right.
	return {
		wire: mapping.wire,
		data,
		...(event.seq !== undefined ? { id: `${event.sessionId}:${event.seq}` } : {}),
	}
}

/** @deprecated Use mapSessionEventToStreamEvent */
export const mapSessionToStreamEvent = mapSessionEventToStreamEvent
