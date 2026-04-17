import type { StreamEventType } from '../../contracts/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/events.js'

export interface MappedStreamEvent {
	wire: StreamEventType
	data: Record<string, unknown>
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

	iteration_completed: {
		wire: 'iteration.completed',
		transform: (e, runId) => ({ run_id: runId, iteration: e.iteration }),
	},

	llm_response: {
		wire: 'message.delta',
		transform: (e, runId) => ({
			run_id: runId,
			content: e.content ?? null,
			has_tool_calls: !!e.hasToolCalls,
		}),
	},

	tool_executing: {
		wire: 'tool.executing',
		transform: (e, runId) => ({
			run_id: runId,
			tool_name: e.toolName,
			input: e.input,
		}),
	},

	tool_completed: {
		wire: 'tool.completed',
		transform: (e, runId) => ({
			run_id: runId,
			tool_name: e.toolName,
			result: e.result,
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

	return { wire: mapping.wire, data }
}

/** @deprecated Use mapRunToStreamEvent */
export const mapSessionToStreamEvent = mapRunToStreamEvent
