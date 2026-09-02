import type {
	A2AStreamEvent,
	TaskArtifactUpdateEvent,
	TaskStatusUpdateEvent,
} from '../../types/a2a/index.js'

import type { RunEvent } from '../../types/run/events.js'

function statusEvent(
	taskId: string,
	state: TaskStatusUpdateEvent['status']['state'],
	isFinal: boolean,
	contextId?: string,
	message?: TaskStatusUpdateEvent['status']['message'],
	metadata?: Record<string, unknown>,
): TaskStatusUpdateEvent {
	return {
		taskId,
		contextId,
		status: {
			state,
			message,
			timestamp: new Date().toISOString(),
		},
		final: isFinal,
		...(metadata !== undefined ? { metadata } : {}),
	}
}

function artifactEvent(
	taskId: string,
	contextId: string | undefined,
	artifact: TaskArtifactUpdateEvent['artifact'],
): TaskArtifactUpdateEvent {
	return {
		taskId,
		contextId,
		artifact,
	}
}

type A2ATransform<K extends RunEvent['type']> =
	| ((event: Extract<RunEvent, { type: K }>, contextId?: string) => A2AStreamEvent | null)
	| null

const MAPPING: {
	[K in RunEvent['type']]: A2ATransform<K>
} = {
	run_started: (e, ctx) => statusEvent(e.runId, 'running', false, ctx),

	run_completed: (e, ctx) => {
		const completedEvent = statusEvent(e.runId, 'completed', true, ctx, {
			role: 'agent',
			parts: [{ kind: 'text', text: e.result }],
		})
		return completedEvent
	},

	run_failed: (e, ctx) =>
		statusEvent(
			e.runId,
			'failed',
			true,
			ctx,
			{
				role: 'agent',
				parts: [{ kind: 'text', text: e.error }],
			},
			// The classification travels as metadata rather than being
			// flattened into the text: a remote peer deciding whether to
			// retry needs `retryable` and the code, not prose it would have
			// to pattern-match.
			e.failure
				? {
						code: e.failure.code,
						retryable: e.failure.retryable,
						...(e.failure.details ? { details: e.failure.details } : {}),
					}
				: undefined,
		),

	// Capability degradation is host-facing diagnostics, not A2A task state.
	capability_warning: null,

	// Local history normalization is an operator/audit fact. The peer receives
	// only the repaired provider-valid conversation, never this host's storage
	// diagnosis or its counts.
	message_history_repaired: null,

	// Who approves on THIS side is an operator fact about this host, not a
	// transition in the task the peer is watching. Forwarding it would also
	// tell a remote caller how loosely its work is being supervised, which
	// is not the peer's business.
	approval_policy_changed: null,

	iteration_started: (e, ctx) =>
		statusEvent(e.runId, 'running', false, ctx, {
			role: 'agent',
			parts: [{ kind: 'text', text: `Iteration ${e.iteration} started` }],
		}),

	// A2A models discrete artifacts and task-status transitions; a progress
	// tick is neither, so it has no A2A representation.
	tool_progress: null,

	// A retry IS a task-status transition in A2A's model — the task is
	// still running and this says why nothing is arriving. Reported as
	// working rather than failed: the call has not given up.
	provider_retry: (e, ctx) =>
		statusEvent(e.runId, 'running', false, ctx, {
			role: 'agent',
			parts: [
				{
					kind: 'text',
					text: `Model call failed (${e.code}); retrying in ${e.delayMs}ms — attempt ${e.attempt} of ${e.maxRetries}`,
				},
			],
		}),

	// A swap is news for a remote peer for the same reason it is news for a
	// local operator: the answer arriving next was produced by a provider the
	// peer did not ask for. Still `running` — the run did not fail, it moved.
	provider_fallback: (e, ctx) =>
		statusEvent(e.runId, 'running', false, ctx, {
			role: 'agent',
			parts: [
				{
					kind: 'text',
					text:
						`Provider ${e.fromProviderId}${e.fromModel ? ` (${e.fromModel})` : ''} could not serve ` +
						`(${e.code}); continuing on ${e.toProviderId}${e.toModel ? ` (${e.toModel})` : ''}`,
				},
			],
		}),

	tool_completed: (e, ctx) =>
		artifactEvent(e.runId, ctx, {
			artifactId: `tool-${e.toolName}-${Date.now()}`,
			name: `${e.toolName} result`,
			parts: [{ kind: 'text', text: e.result }],
			metadata: {
				toolName: e.toolName,
				toolUseId: e.toolUseId,
				isError: e.isError,
			},
		}),

	user_question_asked: (e, ctx) =>
		statusEvent(e.runId, 'input-required', false, ctx, {
			role: 'agent',
			parts: [
				{ kind: 'text', text: e.question },
				{
					kind: 'data',
					data: { questionId: e.questionId, checkpointId: e.checkpointId },
					mimeType: 'application/x-namzu-user-question',
				},
			],
		}),

	// The task leaves `input-required` by the next status event it emits;
	// a second one here would only restate what the resumed run says.
	user_question_answered: null,

	tool_review_requested: (e, ctx) => {
		const toolNames = e.toolCalls.map((tc) => tc.name).join(', ')
		return statusEvent(e.runId, 'input-required', false, ctx, {
			role: 'agent',
			parts: [
				{ kind: 'text', text: `Review requested for tools: ${toolNames}` },
				{
					kind: 'data',
					data: {
						toolCalls: e.toolCalls.map((tc) => ({
							id: tc.id,
							name: tc.name,
							isDestructive: tc.isDestructive,
						})),
					},
					mimeType: 'application/x-namzu-review-request',
				},
			],
		})
	},

	plan_ready: (e, ctx) =>
		statusEvent(e.runId, 'input-required', false, ctx, {
			role: 'agent',
			parts: [
				{ kind: 'text', text: `Plan ready: ${e.title}` },
				{
					kind: 'data',
					data: {
						planId: e.planId,
						title: e.title,
						summary: e.summary,
						steps: e.steps.map((s) => ({
							id: s.id,
							description: s.description,
							toolName: s.toolName,
						})),
					},
					mimeType: 'application/x-namzu-plan',
				},
			],
		}),

	run_paused: (e, ctx) =>
		statusEvent(
			e.runId,
			'input-required',
			false,
			ctx,
			{
				role: 'agent',
				parts: [{ kind: 'text', text: `Run paused: ${e.reason}` }],
			},
			// A remote host has the same recovery decision as a local one. The
			// checkpoint is the address of that recovery; the classification tells
			// it whether and when a retry is justified.
			{
				checkpointId: e.checkpointId,
				...(e.failure
					? {
							code: e.failure.code,
							retryable: e.failure.retryable,
							...(e.failure.details ? { details: e.failure.details } : {}),
						}
					: {}),
			},
		),

	iteration_completed: null,
	// Context management is kernel-internal bookkeeping; A2A peers model a
	// task lifecycle, not the host runtime's memory strategy.
	// What THIS runtime asked its model is not a fact about the task a peer
	// is tracking, and it is the largest single payload the kernel emits.
	request_envelope: null,
	// Declined. This carries whole message bodies including tool output, and
	// a peer models a task lifecycle — shipping a run's deleted history over
	// an external wire by default is a disclosure nobody asked for.
	compaction_shed: null,
	compaction_completed: null,
	// Same reason as the two below: which of this runtime's context-relief
	// strategies fired is a property of how it manages its own window, and a
	// peer modelling a task lifecycle can act on none of them.
	compaction_tool_results_cleared: null,
	// What the run wrote to its own memory store is this runtime's business;
	// a peer sees the task's outcome, not its housekeeping.
	memory_consolidated: null,
	// Compaction, succeeded or declined, is a property of how this runtime
	// manages its own context. A peer models a task lifecycle and cannot act on
	// either outcome.
	compaction_failed: null,
	// A refusal is the run's own policy decision; the peer sees it in the
	// terminal task state, not as a separate signal.
	guardrail_triggered: null,
	// Reasoning is kernel-internal: an A2A peer models a task lifecycle,
	// not the host runtime's inner monologue.
	reasoning_started: null,
	reasoning_delta: null,
	reasoning_completed: null,
	tool_executing: null,
	tool_review_completed: null,
	checkpoint_created: null,
	run_resuming: null,
	token_usage_updated: null,
	activity_created: null,
	activity_updated: null,
	plan_approved: null,
	plan_rejected: null,
	plan_step_updated: null,
	plan_completed: null,
	plan_failed: null,

	agent_pending: null,
	agent_completed: null,
	agent_failed: null,
	agent_canceled: null,

	task_created: null,
	task_updated: null,

	plugin_hook_executing: null,
	plugin_hook_completed: null,

	sandbox_created: null,
	sandbox_exec: null,
	sandbox_destroyed: null,

	// Sub-session lifecycle events (session-hierarchy.md §10.4). These are
	// in-flight visibility signals for the kernel bus; the A2A bridge does not
	// surface them today.
	subsession_spawned: null,
	subsession_messaged: null,
	subsession_idled: null,

	// v3 message + tool-input lifecycle (ses_001-tool-stream-events). A2A's
	// status-update model is coarse-grained, so per-delta events are dropped
	// at this layer. `message_completed` carries the aggregated assistant
	// content — A2A surfaces a single status event with the
	// full text, replacing the per-iteration `llm_response` mapping.
	message_started: null,
	text_delta: null,
	message_completed: (e, ctx) => {
		if (!e.content) return null
		return statusEvent(e.runId, 'running', false, ctx, {
			role: 'agent',
			parts: [{ kind: 'text', text: e.content }],
		})
	},
	tool_input_started: null,
	tool_input_delta: null,
	tool_input_completed: null,
}

export function mapRunToA2AEvent(event: RunEvent, contextId?: string): A2AStreamEvent | null {
	const transform = MAPPING[event.type]
	if (!transform) return null
	return (transform as (event: RunEvent, contextId?: string) => A2AStreamEvent | null)(
		event,
		contextId,
	)
}

/** @deprecated Use mapRunToA2AEvent */
export const mapSessionToA2AEvent = mapRunToA2AEvent
