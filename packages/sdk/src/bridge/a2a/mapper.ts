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
		statusEvent(e.runId, 'failed', true, ctx, {
			role: 'agent',
			parts: [{ kind: 'text', text: e.error }],
		}),

	iteration_started: (e, ctx) =>
		statusEvent(e.runId, 'running', false, ctx, {
			role: 'agent',
			parts: [{ kind: 'text', text: `Iteration ${e.iteration} started` }],
		}),

	llm_response: (e, ctx) => {
		if (!e.content) return null
		return statusEvent(e.runId, 'running', false, ctx, {
			role: 'agent',
			parts: [{ kind: 'text', text: e.content }],
		})
	},

	tool_completed: (e, ctx) =>
		artifactEvent(e.runId, ctx, {
			artifactId: `tool-${e.toolName}-${Date.now()}`,
			name: `${e.toolName} result`,
			parts: [{ kind: 'text', text: e.result }],
			metadata: { toolName: e.toolName },
		}),

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
		statusEvent(e.runId, 'input-required', false, ctx, {
			role: 'agent',
			parts: [{ kind: 'text', text: `Run paused: ${e.reason}` }],
		}),

	iteration_completed: null,
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
