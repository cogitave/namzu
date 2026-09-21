import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, PlanId, SessionId, TurnId } from '../ids/index.js'

export type { CheckpointId }

export type HITLResumeDecision =
	| { action: 'continue' }
	| { action: 'approve_plan'; feedback?: string }
	| { action: 'reject_plan'; feedback: string }
	| {
			action: 'approve_tools'
			/**
			 * Grant keys to remember, so calls covered by them are not asked
			 * about again for the rest of the turn.
			 *
			 * Nothing is remembered unless this says so, and only an explicit
			 * approval can say it — a denial or a non-response leaves nothing
			 * behind. Non-reuse was deliberate ("consent is not
			 * transferable"); what changes is that the SCOPE becomes the
			 * approver's to choose rather than being fixed at "this one call"
			 * or, in the only escape available, "everything for the session".
			 *
			 * Keys come from {@link ToolGrantKeys}, so a grant can be as
			 * narrow as one exact invocation or as wide as a whole tool.
			 * `bash` is unconditionally non-read-only and in no allowlist, so
			 * `bash: git status` re-prompted on every batch forever and the
			 * only way out was a blanket grant that also covered `rm -rf`.
			 */
			remember?: readonly string[]
	  }
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
			 * after question N+1 re-parked under the same turn. When
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
	| {
			type: 'plan_approval'
			sessionId: SessionId
			turnId: TurnId
			checkpointId: CheckpointId
			plan: PlanApprovalData
	  }
	| {
			type: 'tool_review'
			sessionId: SessionId
			turnId: TurnId
			checkpointId: CheckpointId
			toolCalls: ToolCallSummary[]
	  }
	| {
			type: 'iteration_checkpoint'
			sessionId: SessionId
			turnId: TurnId
			checkpointId: CheckpointId
			summary: CheckpointSummary
	  }
	| {
			type: 'user_question'
			sessionId: SessionId
			turnId: TurnId
			checkpointId: CheckpointId
			question: UserQuestionData
	  }

export type ResumeHandler = (request: HITLDecisionRequest) => Promise<HITLResumeDecision>

export interface ToolCallSummary {
	id: string
	name: string
	input: unknown
	isDestructive: boolean
	/**
	 * Operator-policy verdict attached to the exact input shown for review.
	 *
	 * Persisted with a durable review so a later process cannot treat a call
	 * the gate denied as approved merely because the human approved a mixed
	 * batch. Absent only on checkpoints written before this field existed.
	 */
	authorization?: {
		decision: 'allow' | 'deny' | 'review'
		reason?: string
		/** A matching rule requested review; read-only exemptions must not bypass it. */
		explicitReview?: true
	}
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

		/**
		 * Which agent the step is to be delegated to, when it is delegated.
		 *
		 * `PlanStep` gained this so an approver could see WHICH agent a step
		 * goes to rather than only THAT it delegates — approving "delegate
		 * this" is not approving "delegate this to the agent with shell
		 * access". It reached `PlanApprovalRequest`, which is the shape a host
		 * sees when it installs its own handler on `PlanManager`.
		 *
		 * It did not reach here, and this is the ordinary path: every host
		 * using `resumeHandler` is served by this type, and both mappers that
		 * build it copy field by field. So the fix landed on one of the two
		 * approval surfaces and the busier one kept showing
		 * `toolName: 'create_task'` and nothing else.
		 */
		agentId?: string

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

/**
 * A decision a turn is parked on, recorded durably (`decision_requested`).
 *
 * Without this the park exists only as a suspended `await` inside one
 * process: a checkpoint written at a tool-review gate looks identical to a
 * checkpoint written mid-run, so nothing on disk says "a human owes this
 * run an answer". Kill the process and the request is gone — the approval
 * queue a host would build from durable state has nothing to read, and a
 * resumed turn silently re-asks the model instead of honoring the approval
 * that was already granted.
 *
 * `request` is stored verbatim so a fresh process can render exactly what
 * the human was shown, and apply the answer to exactly those tool calls.
 */
export interface PendingDecision {
	/** The request the turn parked on, as the `resumeHandler` received it. */
	readonly request: HITLDecisionRequest
	/** Epoch ms at which the turn parked. */
	readonly parkedAt: number
	/**
	 * Epoch ms after which this park is no longer worth serving.
	 *
	 * Absolute, not a duration, so it survives the process that set it —
	 * every timer in the SDK is an in-process `setTimeout` and the
	 * park-record delay is deliberately `unref`'d, so nothing in-memory can
	 * outlive a redeploy. Without it a turn parks for approval, the worker is
	 * replaced, nobody answers, and the checkpoint stays outstanding
	 * forever: every approval-queue reader keeps serving it and its
	 * workspace is never reclaimed.
	 *
	 * The turn timeout cannot cover this. `checkLimitsDetailed` is only
	 * reached between iterations and a park suspends mid-iteration, so a
	 * long-lived process hard-stops the turn immediately AFTER the human
	 * finally approves, while across a restart the restored elapsed time
	 * excludes parked time entirely — the same configuration giving two
	 * opposite outcomes.
	 *
	 * Absent means no deadline, which is today's behaviour.
	 */
	readonly deadlineAt?: number
	/**
	 * Set once the decision arrives, so a resolved checkpoint stays
	 * distinguishable from one that was never parked. A checkpoint is
	 * outstanding when `pending` is set and `resolvedAt` is not.
	 */
	readonly resolvedAt?: number
	/** The answer, when one arrived. Kept as evidence of who decided what. */
	readonly decision?: HITLResumeDecision
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
