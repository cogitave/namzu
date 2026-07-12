import type { StreamEventType } from '../../contracts/index.js'
import type { RunEvent } from '../../types/run/events.js'

export interface MappedStreamEvent {
	wire: StreamEventType
	data: Record<string, unknown>
}

type EventTransform<K extends RunEvent['type']> = {
	wire: StreamEventType
	transform: (event: Extract<RunEvent, { type: K }>) => Record<string, unknown>
} | null

const MAPPING: {
	[K in RunEvent['type']]: EventTransform<K>
} = {
	run_started: {
		wire: 'run.started',
		transform: (e) => ({
			run_id: e.runId,
			system_prompt: e.systemPrompt ?? null,
		}),
	},

	iteration_started: {
		wire: 'iteration.started',
		transform: (e) => ({ run_id: e.runId, iteration: e.iteration }),
	},

	iteration_completed: {
		wire: 'iteration.completed',
		transform: (e) => ({ run_id: e.runId, iteration: e.iteration }),
	},

	llm_response: {
		wire: 'message.delta',
		transform: (e) => ({
			run_id: e.runId,
			content: e.content ?? null,
			has_tool_calls: !!e.hasToolCalls,
		}),
	},

	tool_executing: {
		wire: 'tool.executing',
		transform: (e) => ({
			run_id: e.runId,
			tool_name: e.toolName,
			input: e.input,
		}),
	},

	tool_completed: {
		wire: 'tool.completed',
		transform: (e) => ({
			run_id: e.runId,
			tool_name: e.toolName,
			result: e.result,
		}),
	},

	tool_review_requested: {
		wire: 'review.requested',
		transform: (e) => ({
			run_id: e.runId,
			tool_calls: e.toolCalls,
			iteration: e.iteration,
		}),
	},

	tool_review_completed: {
		wire: 'review.completed',
		transform: (e) => ({
			run_id: e.runId,
			decision: e.decision,
		}),
	},

	checkpoint_created: {
		wire: 'checkpoint.created',
		transform: (e) => ({
			run_id: e.runId,
			checkpoint_id: e.checkpointId,
			iteration: e.iteration,
		}),
	},

	run_paused: {
		wire: 'run.paused',
		transform: (e) => ({
			run_id: e.runId,
			checkpoint_id: e.checkpointId,
			reason: e.reason,
		}),
	},

	run_resuming: {
		wire: 'run.resuming',
		transform: (e) => ({
			run_id: e.runId,
			from_checkpoint_id: e.fromCheckpointId,
		}),
	},

	token_usage_updated: {
		wire: 'token.usage',
		transform: (e) => ({
			run_id: e.runId,
			usage: e.usage,
			cost: e.cost,
		}),
	},

	activity_created: {
		wire: 'activity.created',
		transform: (e) => ({
			run_id: e.runId,
			activity_id: e.activityId,
			activity_type: e.activityType,
			description: e.description,
		}),
	},

	activity_updated: {
		wire: 'activity.updated',
		transform: (e) => ({
			run_id: e.runId,
			activity_id: e.activityId,
			status: e.status,
			output: e.output,
			error: e.error,
		}),
	},

	plan_ready: {
		wire: 'plan.ready',
		transform: (e) => ({
			run_id: e.runId,
			plan_id: e.planId,
			title: e.title,
			steps: e.steps,
			summary: e.summary,
		}),
	},

	plan_approved: {
		wire: 'plan.approved',
		transform: (e) => ({ run_id: e.runId, plan_id: e.planId }),
	},

	plan_rejected: {
		wire: 'plan.rejected',
		transform: (e) => ({
			run_id: e.runId,
			plan_id: e.planId,
			reason: e.reason,
		}),
	},

	plan_step_updated: {
		wire: 'plan.step_updated',
		transform: (e) => ({
			run_id: e.runId,
			plan_id: e.planId,
			step_id: e.stepId,
			status: e.status,
		}),
	},

	run_completed: null,
	run_failed: null,

	agent_pending: {
		wire: 'agent.pending',
		transform: (e) => ({
			run_id: e.runId,
			task_id: e.taskId,
			parent_agent_id: e.parentAgentId,
			child_agent_id: e.childAgentId,
			depth: e.depth,
		}),
	},

	agent_completed: {
		wire: 'agent.completed',
		transform: (e) => ({
			run_id: e.runId,
			task_id: e.taskId,
			result: e.result?.result,
		}),
	},

	agent_failed: {
		wire: 'agent.failed',
		transform: (e) => ({
			run_id: e.runId,
			task_id: e.taskId,
			error: e.error,
		}),
	},

	agent_canceled: {
		wire: 'agent.canceled',
		transform: (e) => ({
			run_id: e.runId,
			task_id: e.taskId,
		}),
	},

	task_created: {
		wire: 'task.created',
		transform: (e) => ({
			run_id: e.runId,
			task_id: e.taskId,
			subject: e.subject,
			status: e.status,
		}),
	},

	task_updated: {
		wire: 'task.updated',
		transform: (e) => ({
			run_id: e.runId,
			task_id: e.taskId,
			subject: e.subject,
			status: e.status,
			owner: e.owner ?? null,
		}),
	},

	plugin_hook_executing: {
		wire: 'plugin.hook_executing',
		transform: (e) => ({
			run_id: e.runId,
			plugin_id: e.pluginId,
			hook_event: e.hookEvent,
		}),
	},

	plugin_hook_completed: {
		wire: 'plugin.hook_completed',
		transform: (e) => ({
			run_id: e.runId,
			plugin_id: e.pluginId,
			hook_event: e.hookEvent,
			result_action: e.result.action,
			error: e.error,
		}),
	},

	sandbox_created: {
		wire: 'sandbox.created',
		transform: (e) => ({
			run_id: e.runId,
			sandbox_id: e.sandboxId,
			environment: e.environment,
		}),
	},

	sandbox_exec: {
		wire: 'sandbox.exec',
		transform: (e) => ({
			run_id: e.runId,
			sandbox_id: e.sandboxId,
			command: e.command,
			exit_code: e.exitCode,
			duration_ms: e.durationMs,
		}),
	},

	sandbox_destroyed: {
		wire: 'sandbox.destroyed',
		transform: (e) => ({ run_id: e.runId, sandbox_id: e.sandboxId }),
	},

	// Sub-session lifecycle events (session-hierarchy.md §10.4). These are
	// in-flight signals carried on the kernel bus; the SSE wire surface does
	// not emit them today.
	subsession_spawned: null,
	subsession_messaged: null,
	subsession_idled: null,
}

/**
 * Map one {@link RunEvent} onto its SSE wire shape, or `null` for the variants
 * the wire does not carry.
 *
 * `run_id` comes off the EVENT. Until ses_017 P3 this function took a second
 * `runId` argument and stamped it onto every event it emitted, discarding
 * `event.runId` — which meant the API's run id and the SDK's run id could
 * differ for the same run and no client could ever see it. That substitution
 * was load-bearing only because the ids diverged; now that every agent runs
 * under the caller's id (one-canonical-name), it can only mask bugs.
 *
 * A consequence worth naming: a sub-agent's events reach the parent's listener
 * (`AgentManager.wrapChildListener`), and they now go out under the CHILD's run
 * id — because that is whose run they are — carrying `lineage` to place them.
 * They are no longer relabelled as the parent's.
 */
export function mapRunToStreamEvent(event: RunEvent): MappedStreamEvent | null {
	const mapping = MAPPING[event.type]
	if (!mapping) return null

	const data = (mapping.transform as (event: RunEvent) => Record<string, unknown>)(event)

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
