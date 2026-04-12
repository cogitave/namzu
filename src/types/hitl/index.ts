import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, PlanId, RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { PlanStatus } from '../plan/index.js'

export type { CheckpointId }

export type HITLResumeDecision =
	| { action: 'continue' }
	| { action: 'approve_plan' }
	| { action: 'reject_plan'; feedback: string }
	| { action: 'approve_tools' }
	| { action: 'modify_tools'; modifications: ToolModification[] }
	| { action: 'reject_tools'; feedback: string }
	| { action: 'pause'; reason: string }
	| { action: 'abort'; reason: string }

export type HITLDecisionRequest =
	| { type: 'plan_approval'; runId: RunId; checkpointId: CheckpointId; plan: PlanApprovalData }
	| { type: 'tool_review'; runId: RunId; checkpointId: CheckpointId; toolCalls: ToolCallSummary[] }
	| {
			type: 'iteration_checkpoint'
			runId: RunId
			checkpointId: CheckpointId
			summary: CheckpointSummary
	  }

export type ResumeHandler = (request: HITLDecisionRequest) => Promise<HITLResumeDecision>

export interface ToolCallSummary {
	id: string
	name: string
	input: unknown
	isDestructive: boolean
}

export interface ToolModification {
	toolCallId: string
	action: 'approve' | 'deny' | 'modify'
	modifiedInput?: unknown
}

export interface PlanApprovalData {
	planId: PlanId
	title: string
	steps: Array<{
		id: string
		description: string
		toolName?: string
		dependsOn: string[]
		order: number
	}>
	summary?: string
}

export interface CheckpointSummary {
	iteration: number
	messageCount: number
	tokenUsage: TokenUsage
	costInfo: CostInfo
	lastAssistantMessage?: string
}

export interface ActiveNodeInfo {
	agentId: string
	agentType: 'reactive' | 'pipeline' | 'router' | 'supervisor'

	nodeRef?: string

	parentAgentId?: string

	depth: number
}

export interface BranchStackEntry {
	agentId: string
	decision: string
	confidence: number
	timestamp: number
}

export interface IterationCheckpoint {
	id: CheckpointId
	runId: RunId
	iteration: number
	messages: Message[]
	tokenUsage: TokenUsage
	costInfo: CostInfo
	planStatus?: PlanStatus
	guardState: {
		iterationCount: number
		elapsedMs: number
	}
	createdAt: number

	toolResultHashes?: Record<string, string>

	branchStack?: BranchStackEntry[]

	activeNode?: ActiveNodeInfo
}

export function autoApproveHandler(request: HITLDecisionRequest): Promise<HITLResumeDecision> {
	switch (request.type) {
		case 'plan_approval':
			return Promise.resolve({ action: 'approve_plan' })
		case 'tool_review':
			return Promise.resolve({ action: 'approve_tools' })
		case 'iteration_checkpoint':
			return Promise.resolve({ action: 'continue' })
		default: {
			const _exhaustive: never = request
			throw new Error(`Unhandled HITL request type: ${(_exhaustive as HITLDecisionRequest).type}`)
		}
	}
}
