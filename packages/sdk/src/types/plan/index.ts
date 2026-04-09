import type { PlanId, RunId } from '../ids/index.js'

export type PlanStatus =
	| 'generating'
	| 'ready'
	| 'pending_approval'
	| 'approved'
	| 'rejected'
	| 'executing'
	| 'completed'
	| 'failed'

export function isTerminalPlanStatus(status: PlanStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'rejected'
}

export interface PlanStep {
	id: string
	description: string
	toolName?: string
	estimatedInput?: unknown
	dependsOn: string[]
	status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
	error?: string
	order: number
}

export interface Plan {
	id: PlanId
	runId: RunId
	status: PlanStatus
	title: string
	summary?: string
	steps: PlanStep[]
	rawContent?: string
	createdAt: number
	readyAt?: number
	approvedAt?: number
	rejectedAt?: number
	completedAt?: number
	rejectionReason?: string
}

export interface PlanApprovalRequest {
	planId: PlanId
	runId: RunId
	title: string
	steps: PlanStep[]
	summary?: string
}

export interface PlanApprovalResponse {
	approved: boolean
	feedback?: string
	modifiedSteps?: PlanStep[]
}
