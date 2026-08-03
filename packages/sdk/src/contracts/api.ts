import type { AgentCapabilities, AgentType } from '../types/agent/base.js'
import type { ProjectId, RunId, SessionId } from '../types/ids/index.js'
import type { MessageRole } from '../types/message/index.js'
import type { StopReason } from '../types/run/events.js'

export type { MessageRole, StopReason, AgentType, AgentCapabilities }

export type ISOTimestamp = string

export interface AgentDefaults {
	model: string
	temperature?: number
	tokenBudget: number
	maxResponseTokens?: number
	timeoutMs?: number
}

export interface AgentInfo {
	id: string
	name: string
	version: string
	category: string
	description: string
	tools: string[]
	defaults: AgentDefaults
	type?: AgentType
	capabilities?: AgentCapabilities
}

export interface ToolCallInfo {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

export interface CreateMessageRequest {
	role: 'user'
	content: string
	metadata?: Record<string, unknown>
}

/**
 * Wire-side run status for HTTP / A2A / SSE payloads.
 *
 * Distinct from the domain {@link import('../types/run/status.js').RunStatus}
 * which models the kernel state machine. The wire enum collapses domain
 * variants onto the HTTP-facing shape (e.g. domain `succeeded` → wire
 * `completed`; domain `awaiting_hitl*` → wire `running`; domain
 * `awaiting_subsession` → wire `running`).
 */
export type WireRunStatus =
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'cancelling'
	/**
	 * The run's approval window closed with nobody answering.
	 *
	 * Set by a host sweeping expired parks — there is no domain status that
	 * collapses onto it, because the kernel is suspended mid-iteration while
	 * parked and never gets to observe its own deadline passing.
	 */
	| 'expired'

// Wire-side rename of types/run/events.StopReason. Kept distinct so the HTTP
// payload field name (`stop_reason`) stays decoupled from the internal type
// identifier even if the domain type is later renamed.
export type RunStopReason = StopReason

export interface WireRun {
	id: RunId
	project_id: ProjectId | null
	session_id?: SessionId
	agent_id: string
	agent_name?: string
	status: WireRunStatus
	stop_reason?: RunStopReason
	created_at: ISOTimestamp
	started_at?: ISOTimestamp
	completed_at?: ISOTimestamp
	duration_ms?: number
	model?: string
	config: RunConfig
	usage?: RunUsage
	iterations?: number
	result?: string
	last_error?: string

	parent_run_id?: RunId

	depth?: number

	child_run_ids?: RunId[]
}

export interface RunHierarchyNode {
	run_id: RunId
	agent_id: string
	depth: number
	status: WireRunStatus
	children: RunHierarchyNode[]
}

export type ApiPermissionMode = 'plan' | 'auto'

export interface RunConfig {
	model?: string
	temperature?: number
	tokenBudget?: number
	maxResponseTokens?: number
	timeoutMs?: number
	permissionMode?: ApiPermissionMode

	systemPrompt?: string
}

export interface RunUsage {
	input_tokens: number
	output_tokens: number
	total_tokens: number
	total_cost_usd?: number
}

export interface CreateRunRequest {
	agent_id: string
	config: RunConfig
	env?: Record<string, string>
	stream?: boolean
}

export interface CreateStatelessRunRequest {
	agent_id: string
	message: string
	config: RunConfig
	env?: Record<string, string>
}

export type StreamEventType =
	| 'run.started'
	| 'run.completed'
	| 'run.failed'
	| 'run.cancelled'
	| 'run.paused'
	| 'run.resuming'
	| 'iteration.started'
	| 'iteration.completed'
	/**
	 * A compaction pass replaced a span of history with a summary. Wire-
	 * visible because the operation is destructive: a client rendering the
	 * transcript needs to know its middle was dropped, not infer it.
	 */
	| 'compaction.completed'
	/** A guardrail refused or corrected the run. */
	| 'guardrail.triggered'
	/**
	 * Extended-thinking lifecycle. Wire-visible because without it a
	 * client renders a multi-second stall with no events while the model
	 * is demonstrably working.
	 */
	| 'reasoning.started'
	| 'reasoning.delta'
	| 'reasoning.completed'
	/**
	 * A model call failed transiently and is being retried after a backoff.
	 * Wire-visible on the same grounds as `tool.progress` and the reasoning
	 * events: without it a client sees no event and no keepalive for the
	 * whole backoff, so a run that is about to succeed is indistinguishable
	 * from one that has hung.
	 */
	| 'provider.retry'
	| 'tool.executing'
	/** Ephemeral progress from a long-running tool. Not in the transcript. */
	| 'tool.progress'
	| 'tool.completed'
	| 'tool.error'
	// v3 tool input lifecycle (ses_001-tool-stream-events). Additive; phase 4
	// of the migration removes `tool.error` and folds the boolean into
	// `tool.completed`. Until then both surfaces are wire-supported so
	// adapters can roll forward independently.
	| 'tool.input_started'
	| 'tool.input_delta'
	| 'tool.input_completed'
	| 'token.usage'
	| 'message.created'
	| 'message.delta'
	| 'message.completed'
	/**
	 * A tool asked the user a question and the run is parked on it. Wire-
	 * visible for the same reason `review.requested` is: a client cannot
	 * render an approval card for something it never hears about.
	 */
	| 'question.asked'
	| 'question.answered'
	| 'review.requested'
	| 'review.completed'
	| 'checkpoint.created'
	| 'activity.created'
	| 'activity.updated'
	| 'plan.ready'
	| 'plan.approved'
	| 'plan.rejected'
	| 'plan.step_updated'
	| 'agent.pending'
	| 'agent.completed'
	| 'agent.failed'
	| 'agent.canceled'
	| 'task.created'
	| 'task.updated'
	| 'plugin.hook_executing'
	| 'plugin.hook_completed'
	| 'sandbox.created'
	| 'sandbox.exec'
	| 'sandbox.destroyed'

export interface StreamEvent {
	event: StreamEventType
	data: Record<string, unknown>
}

export interface PaginationParams {
	limit?: number
	after?: string
	before?: string
	order?: 'asc' | 'desc'
}

export interface PaginatedResponse<T> {
	data: T[]
	has_more: boolean
	first_id: string | null
	last_id: string | null
}

export type ApiErrorType =
	| 'validation_error'
	| 'authentication_error'
	| 'not_found'
	| 'conflict'
	| 'rate_limit_exceeded'
	| 'internal_error'

export interface ApiError {
	error: {
		code: string
		message: string
		type: ApiErrorType
		param?: string
	}
}
