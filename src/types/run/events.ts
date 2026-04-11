import type { ActivityStatus, ActivityType } from '../activity/index.js'
import type { BaseAgentResult } from '../agent/base.js'
import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, ToolCallSummary } from '../hitl/index.js'
import type { ActivityId, PlanId, PluginId, RunId, SandboxId, TaskId } from '../ids/index.js'
import type { PlanStep } from '../plan/index.js'
import type { PluginHookEvent, PluginHookResult } from '../plugin/index.js'
import type { TaskStatus } from '../task/index.js'

export type StopReason =
	| 'end_turn'
	| 'token_budget'
	| 'cost_limit'
	| 'timeout'
	| 'max_iterations'
	| 'cancelled'
	| 'plan_rejected'
	| 'paused'
	| 'error'

export type RunEvent =
	| { type: 'run_started'; runId: RunId; systemPrompt?: string }
	| { type: 'iteration_started'; runId: RunId; iteration: number }
	| {
			type: 'iteration_completed'
			runId: RunId
			iteration: number
			hasToolCalls: boolean
	  }
	| {
			type: 'llm_response'
			runId: RunId
			content: string | null
			hasToolCalls: boolean
	  }
	| {
			type: 'tool_executing'
			runId: RunId
			toolName: string
			input: unknown
	  }
	| {
			type: 'tool_completed'
			runId: RunId
			toolName: string
			result: string
	  }
	| {
			type: 'tool_review_requested'
			runId: RunId
			toolCalls: ToolCallSummary[]
			iteration: number
	  }
	| {
			type: 'tool_review_completed'
			runId: RunId
			decision: 'approved' | 'modified' | 'rejected'
	  }
	| {
			type: 'checkpoint_created'
			runId: RunId
			checkpointId: CheckpointId
			iteration: number
	  }
	| {
			type: 'run_paused'
			runId: RunId
			checkpointId: CheckpointId
			reason: string
	  }
	| {
			type: 'run_resuming'
			runId: RunId
			fromCheckpointId: CheckpointId
	  }
	| { type: 'run_completed'; runId: RunId; result: string }
	| { type: 'run_failed'; runId: RunId; error: string }
	| {
			type: 'token_usage_updated'
			runId: RunId
			usage: TokenUsage
			cost: CostInfo
	  }
	| {
			type: 'activity_created'
			runId: RunId
			activityId: ActivityId
			activityType: ActivityType
			description: string
	  }
	| {
			type: 'activity_updated'
			runId: RunId
			activityId: ActivityId
			status: ActivityStatus
			output?: unknown
			error?: string
	  }
	| {
			type: 'plan_ready'
			runId: RunId
			planId: PlanId
			title: string
			steps: PlanStep[]
			summary?: string
	  }
	| { type: 'plan_approved'; runId: RunId; planId: PlanId }
	| {
			type: 'plan_rejected'
			runId: RunId
			planId: PlanId
			reason?: string
	  }
	| {
			type: 'plan_step_updated'
			runId: RunId
			planId: PlanId
			stepId: string
			status: PlanStep['status']
	  }
	| {
			type: 'agent_pending'
			runId: RunId
			taskId: TaskId
			parentAgentId: string
			childAgentId: string
			depth: number
	  }
	| {
			type: 'agent_completed'
			runId: RunId
			taskId: TaskId
			result: BaseAgentResult
	  }
	| {
			type: 'agent_failed'
			runId: RunId
			taskId: TaskId
			error: string
	  }
	| { type: 'agent_canceled'; runId: RunId; taskId: TaskId }
	| {
			type: 'task_created'
			runId: RunId
			taskId: TaskId
			subject: string
			status: TaskStatus
	  }
	| {
			type: 'task_updated'
			runId: RunId
			taskId: TaskId
			subject: string
			status: TaskStatus
			owner?: string
	  }
	| {
			type: 'plugin_hook_executing'
			runId: RunId
			pluginId: PluginId
			hookEvent: PluginHookEvent
	  }
	| {
			type: 'plugin_hook_completed'
			runId: RunId
			pluginId: PluginId
			hookEvent: PluginHookEvent
			result: PluginHookResult
	  }
	| {
			type: 'sandbox_created'
			runId: RunId
			sandboxId: SandboxId
			environment: string
	  }
	| {
			type: 'sandbox_exec'
			runId: RunId
			sandboxId: SandboxId
			command: string
			exitCode: number
			durationMs: number
	  }
	| { type: 'sandbox_destroyed'; runId: RunId; sandboxId: SandboxId }

export type RunEventListener = (event: RunEvent) => void | Promise<void>
