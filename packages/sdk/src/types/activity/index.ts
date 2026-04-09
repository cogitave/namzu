import type { ActivityId, RunId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'

export type ActivityType = 'tool_call' | 'llm_turn' | 'sub_agent' | 'shell'

export type ActivityStatus =
	| 'pending'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'skipped'

export function isTerminalActivityStatus(status: ActivityStatus): boolean {
	return (
		status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped'
	)
}

export interface ActivityProgress {
	percentage?: number
	message?: string
	updatedAt: number
}

export interface Activity<TInput = unknown, TOutput = unknown> {
	id: ActivityId
	runId: RunId
	type: ActivityType
	status: ActivityStatus
	description: string
	input?: TInput
	output?: TOutput
	error?: string
	parentActivityId?: ActivityId
	blockedBy: ActivityId[]
	blocks: ActivityId[]
	progress?: ActivityProgress
	toolName?: string
	toolCallId?: string
	createdAt: number
	startedAt?: number
	completedAt?: number
	durationMs?: number
}

export interface ActivityTrackingConfig {
	enabled: boolean
	trackToolCalls: boolean
	trackLlmTurns: boolean
}

export function resolveActivityTracking(
	_permissionMode: PermissionMode,
	explicit?: boolean,
): ActivityTrackingConfig {
	if (explicit === false) {
		return { enabled: false, trackToolCalls: false, trackLlmTurns: false }
	}

	return { enabled: true, trackToolCalls: true, trackLlmTurns: true }
}
