import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, DecisionRequestId, PlanId, ResumeToken, RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { PlanStatus } from '../plan/index.js'

export type { CheckpointId, DecisionRequestId, ResumeToken }

/**
 * How a reviewer answers a {@link HITLDecisionRequest}.
 *
 * `pause` is the **durable-pause** signal, and it always was: it parks the run and
 * deliberately leaves the reviewed tool calls unanswered in the history, because the
 * pending batch is what a resume has to act on. What was missing until ses_017 D1 is
 * that nothing about the pending decision was *persisted*, so the pause could not be
 * come back to — the next `query()` repaired the unanswered call away. There is no
 * separate "defer" action: a handler that wants a decision made out-of-process says
 * `pause`, which is what it means.
 */
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
	| {
			type: 'plan_approval'
			requestId: DecisionRequestId
			runId: RunId
			checkpointId: CheckpointId
			plan: PlanApprovalData
	  }
	| {
			type: 'tool_review'
			requestId: DecisionRequestId
			runId: RunId
			checkpointId: CheckpointId
			toolCalls: ToolCallSummary[]
	  }
	| {
			type: 'iteration_checkpoint'
			requestId: DecisionRequestId
			runId: RunId
			checkpointId: CheckpointId
			summary: CheckpointSummary
	  }

export type ResumeHandler = (request: HITLDecisionRequest) => Promise<HITLResumeDecision>

/**
 * Where a persisted decision is in its lifecycle.
 *
 * Persisting only the *request* is not enough, and the missing states are not
 * bookkeeping: without them the record cannot distinguish **"never answered"** from
 * **"approved, then the process died halfway through `executeBatch`"**, and that
 * ambiguity is precisely how a durable pause re-runs a destructive tool.
 *
 *   - `pending` — put to a reviewer, unanswered. The tool-call block is untouched.
 *   - `resolved` — an outcome was recorded (the token was redeemed). Nothing has run.
 *   - `executing` — the batch was dispatched. **Some calls may have already had their
 *     real-world effect.** Recovery from here consults the journal and never guesses;
 *     see {@link ToolExecutionJournalEntry}.
 *   - `settled` — every call has a result in the history. The decision is closed and
 *     no longer owns the tool-call block.
 *   - `cancelled` — the run was cancelled while the decision was open. It can never be
 *     answered; a decision arriving afterwards is inert.
 */
export type PendingDecisionState = 'pending' | 'resolved' | 'executing' | 'settled' | 'cancelled'

/**
 * One entry in the per-call execution journal.
 *
 * The executor fans out with `Promise.all` and pushes results only after the whole
 * batch settles, so **without a journal a crash mid-batch cannot attribute which calls
 * started, which finished, and which lost their result.** The journal is written twice
 * per call: `started` immediately before the batch is dispatched, `settled` the moment
 * that individual call comes back.
 *
 * **Its honest limit.** A crash between a tool's real-world side effect and the
 * `settled` write leaves the call recorded as `started`. `started` therefore means
 * "may or may not have run" — it does not mean "did not run". That gap is irreducible
 * (it is the Two Generals problem, and no reviewed durable-execution engine closes it);
 * what the journal buys is that recovery is *informed* rather than ambiguous. A
 * `settled` call keeps its recorded result and is not re-executed. A `started` call is
 * surfaced to the human as "may have already run" and is not re-executed either.
 * Exactly-once for arbitrary side effects is a fiction; this is at-least-once that
 * never guesses.
 *
 * Durability is against a process crash, not a power loss: the journal is written
 * through the store's tmp-file-plus-rename path, which is atomic but not `fsync`ed.
 */
export interface ToolExecutionJournalEntry {
	toolCallId: string
	toolName: string
	state: 'started' | 'settled'
	at: number
	/**
	 * The tool's output, recorded on settle. Carried in full — not hashed — because
	 * this is what lets a recovered `settled` call keep its result instead of being
	 * re-run for it.
	 */
	output?: string
}

/**
 * A decision the run is parked on, persisted alongside the checkpoint it was raised
 * at. This is the thing whose absence made a pause unresumable.
 */
export interface PendingDecision {
	requestId: DecisionRequestId
	/** The request exactly as it was put to the reviewer, re-emitted verbatim on resume. */
	request: HITLDecisionRequest
	state: PendingDecisionState
	/** Recorded when the token is redeemed. Absent while `pending`. */
	outcome?: HITLResumeDecision
	resumeToken: ResumeToken
	/** Stamped on redemption. Its presence is what makes the token single-use. */
	redeemedAt?: number
	/** Per-call execution record. Populated from `executing` onward. */
	journal?: ToolExecutionJournalEntry[]
	/**
	 * Calls that the journal recorded as started but never settled, discovered while
	 * recovering from a crash in `executing`. They were NOT re-executed and their real
	 * effect is unknown. Surfaced rather than guessed.
	 */
	uncertainToolCallIds?: string[]
	createdAt: number
	updatedAt: number
}

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

	/**
	 * The decision this checkpoint is parked on, if any. Written when a review parks
	 * the run and mutated in place as the decision moves through its state machine.
	 *
	 * This field is the whole of D1. Before it, a checkpoint recorded that a run had
	 * stopped and nothing about *what it had stopped for*, so a resume could not tell a
	 * crash (repair the interrupted call) from a pause (the interrupted call is the
	 * question), and it always chose the first.
	 */
	pendingDecision?: PendingDecision
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

/** Reason recorded on a run parked because nothing in-process was there to review it. */
export const NO_IN_PROCESS_REVIEWER_REASON =
	'No in-process reviewer; awaiting an out-of-process decision'

/**
 * What answers a review when **no in-process handler does** — i.e. `query()` was called
 * without a `resumeHandler`. This is the in-process-vs-durable switch.
 *
 * It answers each request type according to **what that request actually authorizes**,
 * because "fail closed" is a rule about authorization gates and applying it to something
 * that gates nothing produces a stranded run rather than a safe one:
 *
 *   - **`tool_review` → `pause`.** It authorizes tool execution, so with nobody to ask,
 *     nothing runs. The run parks durably and the question is persisted. The alternative
 *     default — auto-approve — would make "I forgot to pass a handler" and "I authorized
 *     this batch" the same program
 *     ([fail-closed-gates](../../../../docs.local/conventions/fail-closed-gates.md)).
 *   - **`plan_approval` → `reject_plan`.** It authorizes a plan, so with nobody to ask
 *     it is refused. It is refused rather than PARKED because the checkpoint captures no
 *     `PlanManager` state: a parked plan approval would have nothing to resume into, and
 *     a pause you cannot come back to is worse than a refusal that says why. Durable
 *     plan approval waits on a PlanManager restore.
 *   - **`iteration_checkpoint` → `continue`.** It authorizes NOTHING. It is an
 *     observation point — "do you want to keep going?" — and `handleHITLDecision` maps
 *     its `continue` straight through. Parking here in the name of fail-closed would
 *     stall every handler-less run at every single iteration boundary, on a question
 *     nobody asked to be asked. That is not safety, it is a hang.
 */
export function deferredReviewHandler(request: HITLDecisionRequest): Promise<HITLResumeDecision> {
	switch (request.type) {
		case 'plan_approval':
			return Promise.resolve({
				action: 'reject_plan',
				feedback:
					'No in-process reviewer. Durable plan approval is not supported: the checkpoint does not capture plan state, so the run would park with nothing to resume into.',
			})
		case 'tool_review':
			return Promise.resolve({ action: 'pause', reason: NO_IN_PROCESS_REVIEWER_REASON })
		case 'iteration_checkpoint':
			return Promise.resolve({ action: 'continue' })
		default: {
			const _exhaustive: never = request
			throw new Error(`Unhandled HITL request type: ${(_exhaustive as HITLDecisionRequest).type}`)
		}
	}
}
