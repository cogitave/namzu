import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, PlanId, RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { PlanStatus } from '../plan/index.js'

export type { CheckpointId }

export type HITLResumeDecision =
	| { action: 'continue' }
	| { action: 'approve_plan'; feedback?: string }
	| { action: 'reject_plan'; feedback: string }
	| { action: 'approve_tools' }
	| { action: 'modify_tools'; modifications: ToolModification[] }
	| { action: 'reject_tools'; feedback: string }
	| {
			action: 'answer_question'
			selectedOptionIds: string[]
			freeText?: string
			/**
			 * Echo of `UserQuestionData.questionId` — the misdirection
			 * guard. The park/resolve registry on hosts is typically
			 * keyed by run, so a stale client can answer question N
			 * after question N+1 re-parked under the same run. When
			 * present and it does not match the asking tool's own
			 * questionId, the tool treats the decision as unanswered
			 * instead of fabricating a selection against the wrong
			 * question.
			 */
			questionId?: string
	  }
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
	| { type: 'user_question'; runId: RunId; checkpointId: CheckpointId; question: UserQuestionData }

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

export interface UserQuestionOption {
	id: string
	label: string
	description?: string
}

/**
 * A model-authored question for the user, parked through the
 * `ResumeHandler` exactly like a plan approval. `questionId` equals
 * the asking `tool_use_id` so the host can mint stable, mergeable
 * activity ids per question and so answers can be matched back to
 * the question that asked them (see
 * `HITLResumeDecision['answer_question'].questionId`).
 */
export interface UserQuestionData {
	questionId: string
	question: string
	header?: string
	options: UserQuestionOption[]
	multiSelect: boolean
	allowFreeText: boolean
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
		case 'user_question':
			// Headless runs must never deadlock on a question and must
			// never fabricate a user choice: answer with an explicit
			// no-selection sentinel so the asking tool renders "the user
			// did not answer" rather than consent.
			return Promise.resolve({
				action: 'answer_question',
				selectedOptionIds: [],
				freeText: 'No user is available to answer. Proceed using your best judgment.',
				questionId: request.question.questionId,
			})
		default: {
			const _exhaustive: never = request
			throw new Error(`Unhandled HITL request type: ${(_exhaustive as HITLDecisionRequest).type}`)
		}
	}
}
