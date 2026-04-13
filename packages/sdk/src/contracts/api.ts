import type { AgentCapabilities, AgentType } from '../types/agent/base.js'
import type { MessageRole } from '../types/message/index.js'
import type { StopReason } from '../types/run/events.js'
import type { MessageId, RunId, SessionId, ThreadId } from './ids.js'

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

export interface Thread {
	id: ThreadId
	created_at: ISOTimestamp
	updated_at: ISOTimestamp
	metadata: Record<string, string>
	message_count: number
}

export interface ToolCallInfo {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

export interface ThreadMessage {
	id: MessageId
	thread_id: ThreadId
	role: MessageRole
	content: string | null
	created_at: ISOTimestamp
	run_id?: RunId
	tool_call_id?: string
	tool_calls?: ToolCallInfo[]
	metadata?: Record<string, unknown>
}

export interface CreateThreadRequest {
	metadata?: Record<string, string>
	messages?: CreateMessageRequest[]
}

export interface CreateMessageRequest {
	role: 'user'
	content: string
	metadata?: Record<string, unknown>
}

export type RunStatus =
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'cancelling'
	| 'expired'

// Wire-side rename of types/run/events.StopReason. Kept distinct so the HTTP
// payload field name (`stop_reason`) stays decoupled from the internal type
// identifier even if the domain type is later renamed.
export type RunStopReason = StopReason

export interface Run {
	id: RunId
	thread_id: ThreadId | null
	session_id?: SessionId
	agent_id: string
	agent_name?: string
	status: RunStatus
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
	status: RunStatus
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
	| 'tool.executing'
	| 'tool.completed'
	| 'tool.error'
	| 'token.usage'
	| 'message.created'
	| 'message.delta'
	| 'message.completed'
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
