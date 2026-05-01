import type { ActivityStatus, ActivityType } from '../activity/index.js'
import type { BaseAgentResult } from '../agent/base.js'
import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, ToolCallSummary } from '../hitl/index.js'
import type {
	ActivityId,
	MessageId,
	PlanId,
	PluginId,
	RunId,
	SandboxId,
	TaskId,
	ToolUseId,
} from '../ids/index.js'
import type { PlanStep } from '../plan/index.js'
import type { PluginHookEvent, PluginHookResult } from '../plugin/index.js'
import type { TaskStatus } from '../task/index.js'
import type { Lineage } from './lineage.js'
import type { MessageStopReason } from './stop-reason.js'
import type {
	SubsessionIdledEvent,
	SubsessionMessagedEvent,
	SubsessionSpawnedEvent,
} from './subsession-events.js'

export type { MessageStopReason, StopReason } from './stop-reason.js'

/**
 * Additive envelope fields present on every {@link RunEvent} variant.
 *
 * Per session-hierarchy.md §10.1 evolution is additive and consumers filter
 * by the `type` discriminator, never by field shape. 0.2.0+ emitters stamp
 * `schemaVersion: 2`; older untagged events are treated as virtually v1 by
 * readers. `lineage` is populated on sub-session emissions (§10.4) and left
 * absent on root-session events.
 */
interface RunEventEnvelope {
	/**
	 * v3 envelope (ses_001-tool-stream-events, 2026-05-01). Removes
	 * `llm_response`; adds message + tool-input lifecycle variants;
	 * tightens `tool_executing` / `tool_completed` payloads. Emitters
	 * stamp this from {@link RUN_EVENT_SCHEMA_VERSION}.
	 */
	schemaVersion?: 3
	lineage?: Lineage
}

type CoreRunEvent =
	| { type: 'run_started'; runId: RunId; systemPrompt?: string }
	| { type: 'iteration_started'; runId: RunId; iteration: number }
	| {
			type: 'iteration_completed'
			runId: RunId
			iteration: number
			hasToolCalls: boolean
	  }
	| {
			type: 'tool_executing'
			runId: RunId
			toolUseId: ToolUseId
			toolName: string
			input: unknown
	  }
	| {
			type: 'tool_completed'
			runId: RunId
			toolUseId: ToolUseId
			toolName: string
			result: string
			isError: boolean
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
	// ─────────────────────────────────────────────────────────────────────
	// v3 message + tool-input lifecycle (additive 2026-05; see
	// ses_001-tool-stream-events). These are not yet emitted by the
	// iteration orchestrator — phase 4 of the migration switches the
	// orchestrator to streaming consumption and removes `llm_response`.
	// Until then these variants exist so consumers can be wired ahead of
	// the producer-side cutover.
	// ─────────────────────────────────────────────────────────────────────
	| {
			type: 'message_started'
			runId: RunId
			iteration: number
			messageId: MessageId
	  }
	| {
			type: 'text_delta'
			runId: RunId
			iteration: number
			messageId: MessageId
			text: string
	  }
	| {
			type: 'message_completed'
			runId: RunId
			iteration: number
			messageId: MessageId
			stopReason: MessageStopReason
			usage?: TokenUsage
			/**
			 * Aggregated assistant text accumulated from `text_delta`
			 * events for this message. Optional so consumers that
			 * already concatenate deltas themselves don't have to pay
			 * the duplication; consumers that only care about the
			 * completed message (telemetry, A2A bridge, postmortem
			 * tooling) can read this field directly.
			 */
			content?: string
	  }
	| {
			type: 'tool_input_started'
			runId: RunId
			iteration: number
			messageId: MessageId
			toolUseId: ToolUseId
			toolName: string
	  }
	| {
			type: 'tool_input_delta'
			runId: RunId
			toolUseId: ToolUseId
			partialJson: string
	  }
	| {
			type: 'tool_input_completed'
			runId: RunId
			toolUseId: ToolUseId
			input: unknown
	  }

/**
 * Discriminated union of all run-scoped events emitted by the kernel.
 *
 * Convention #16: `type` is the sole discriminator for exhaustive switches;
 * envelope fields (`schemaVersion`, `lineage`) are additive and never
 * participate in discrimination. Sub-session lifecycle variants
 * (`subsession_spawned`, `subsession_messaged`, `subsession_idled`) carry a
 * required `lineage` — see session-hierarchy.md §10.4.
 */
export type RunEvent =
	| (CoreRunEvent & RunEventEnvelope)
	| SubsessionSpawnedEvent
	| SubsessionMessagedEvent
	| SubsessionIdledEvent

export type RunEventListener = (event: RunEvent) => void | Promise<void>

/**
 * Event types whose volume makes durable persistence wasteful.
 *
 * `text_delta` and `tool_input_delta` arrive at provider cadence (often
 * 50–100 events per second), carry no information not derivable from the
 * surrounding message/tool lifecycle events, and are not consulted by
 * replay (`runtime/query/replay/prepare.ts` reads checkpoints, not the
 * transcript). The kernel still dispatches them on the in-memory bus so
 * SSE consumers can render live progress, but the disk store
 * (`store/run/disk.ts:appendEvent`) skips them via this predicate.
 *
 * Keeping the predicate centralised — rather than threading an
 * `ephemeral: true` field through every emit site — means new ephemeral
 * variants are added by editing one Set and consumers don't have to
 * inspect event shape to decide what to persist.
 */
const EPHEMERAL_EVENT_TYPES: ReadonlySet<RunEvent['type']> = new Set<RunEvent['type']>([
	'text_delta',
	'tool_input_delta',
])

export function isEphemeralEvent(event: RunEvent): boolean {
	return EPHEMERAL_EVENT_TYPES.has(event.type)
}
