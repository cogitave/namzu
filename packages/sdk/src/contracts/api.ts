import type { AgentCapabilities, AgentType } from '../types/agent/base.js'
import type { SessionId } from '../types/ids/index.js'
import type { MessageRole } from '../types/message/index.js'
import type { PermissionMode } from '../types/permission/index.js'
import type { StopReason } from '../types/session/stop-reason.js'
import type { WireTurnStatus } from './session/turn-status.js'

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
 * One session in a delegation tree, as a host's tree endpoint returns it.
 *
 * A child session is a delegated piece of work; `children` are the sessions it
 * spawned in turn. `status` is the status of the session's latest turn.
 */
export interface SessionTreeNode {
	session_id: SessionId
	agent_id: string
	/** 0 for a root session. */
	depth: number
	status: WireTurnStatus
	children: SessionTreeNode[]
}

/** The wire name for the kernel's `PermissionMode`; one union, not a second copy of it. */
export type ApiPermissionMode = PermissionMode

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
