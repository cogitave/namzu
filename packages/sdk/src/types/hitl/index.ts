import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, PlanId, SessionId, TurnId } from '../ids/index.js'
import type { Message } from '../message/index.js'

export type { CheckpointId }

/** A person's No to a tool call. See the `declined` field of `reject_tools`. */
export interface ToolCallDeclined {
	/** What the person said about it, in their own words. */
	readonly note?: string
}

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
			/**
			 * Ids of calls whose sandbox escape a reviewer confirmed.
			 *
			 * A call that asks to leave the sandbox
			 * (`ToolCallSummary.escalation.sandboxEscape`) runs unconfined only
			 * when its id is here. An approval that does not list it refuses
			 * that call and runs the rest, so a policy that answers
			 * `approve_tools` to everything — an auto mode, a remembered
			 * "approve all", a host's own blanket handler — cannot grant an
			 * escape by accident. `createReviewHandler` fills it only after a
			 * person said yes to a batch that showed the escape.
			 */
			confirmedEscalations?: readonly string[]
			/**
			 * Ids of calls approved on the strength of a skill's `allowed-tools`
			 * grant ({@link ToolCallSummary.skillGrant}), with nobody asked.
			 *
			 * The kernel writes each one to the session's audit trail naming the
			 * skill, and only for a call that actually carried the grant — an id
			 * listed here for an unmarked call is ignored rather than trusted.
			 */
			skillGranted?: readonly string[]
			/**
			 * Ids of calls approved on the strength of a `pre_tool_use` hook's
			 * `allow` ({@link ToolCallSummary.hookGrant}), with nobody asked.
			 *
			 * Audited like `skillGranted`, and ignored for any id whose call did
			 * not carry the mark.
			 */
			hookGranted?: readonly string[]
	  }
	| {
			action: 'modify_tools'
			modifications: ToolModification[]
			/** See the `approve_tools` field of the same name. */
			confirmedEscalations?: readonly string[]
	  }
	| {
			action: 'reject_tools'
			feedback: string
			/**
			 * Present only when a person answered No. `feedback` is what the
			 * MODEL is told and a policy refusal fills it too, so it cannot say
			 * who refused; this does. `note` is the person's own words, apart
			 * from any wrapper a host put around them in `feedback`.
			 */
			declined?: ToolCallDeclined
			/**
			 * The refusal also ends the turn: every call of the batch is answered
			 * first (a call that was running is cancelled, a call that never
			 * started gets the same refusal without being asked), then the turn
			 * stops as an interrupt does and the model is not called again. Absent,
			 * a refusal is an answer the model reads and carries on from.
			 */
			endTurn?: true
	  }
	| {
			action: 'answer_question'
			selectedOptionIds: string[]
			freeText?: string
			/**
			 * One answer per question of a batch (`UserQuestionData.questions`).
			 * When present it is the answer; `selectedOptionIds`/`freeText`
			 * then carry nothing the tool reads (send `[]`). Absent on a
			 * single-question park, and on a batch from a host that only
			 * knows one question — then `selectedOptionIds`/`freeText`
			 * answer the first question and the rest are unanswered.
			 */
			answers?: readonly UserQuestionAnswer[]
			/**
			 * Echo of `UserQuestionData.questionId` — the misdirection
			 * guard. The park/resolve registry on hosts is typically
			 * keyed by turn, so a stale client can answer question N
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
			/**
			 * Set when `toolCalls` is only part of the model's batch: the per-call
			 * review (see {@link PerCallReviewConfig}) asks about one call, or about
			 * the few that must be asked together, while the rest of the batch runs.
			 * Absent, the request names every call of the batch.
			 */
			perCall?: true
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

/**
 * What the turn offers a resume handler besides the request, in memory only.
 *
 * Kept out of {@link HITLDecisionRequest} on purpose: the request is written
 * to the session log when a decision takes long, and a transcript does not
 * belong there. A handler that does not need it ignores the argument; one that
 * wraps another passes it on.
 */
export interface ResumeContext {
	/**
	 * The conversation as it stands now, the batch under review included.
	 * Read on demand; the array is the turn's own, so a caller must not change it.
	 */
	readonly transcript: () => readonly Message[]
	/** The turn's cancellation signal, when it has one. */
	readonly signal?: AbortSignal
}

/**
 * Opt-in: ask about one call at a time while the batch executes.
 *
 * Without it a model response is one batch: every call is reviewed together,
 * one `tool_review` request names them all, and nothing runs until the whole
 * verdict is back. With it the turn walks the calls in the model's order.
 * Calls that are safe to run side by side start together and each opens its own
 * one-call request; a call that is not safe waits for every earlier call to
 * finish, then asks, then runs; an approved call starts at once. A refusal
 * settles every call of the batch and, when it carries `endTurn`, stops the turn.
 *
 * Every request the handler sees in this mode carries `perCall: true`. A host
 * that does not set the option sees exactly the batch requests it always did.
 */
export interface PerCallReviewConfig {
	/**
	 * Subscribe to "a rule or the permission mode changed". The listener is
	 * called with no argument; the returned function unsubscribes. Each call
	 * re-checks every call that is still waiting for an answer.
	 *
	 * A re-check only ever approves: a waiting call that the new rules or mode
	 * cover is let through without being shown, and everything else keeps
	 * waiting. It never refuses. A call that reaches past the turn's boundary,
	 * that the tool itself says always needs a person, or that a rule or hook
	 * asked a person about is never approved by a re-check.
	 */
	readonly onRulesChanged?: (listener: () => void) => () => void
	/**
	 * Whether the host's current rules and mode now let this call run without
	 * asking. Consulted on each change, for each waiting call. Use
	 * `neverCover` for a call whose exact input was not shown in full. Absent, only the
	 * turn's own authorization rules and approvals granted earlier in the turn
	 * are re-checked.
	 */
	readonly covers?: (call: ToolCallSummary) => boolean | Promise<boolean>
	/**
	 * Calls a re-check must never approve, whatever the turn's rules, its
	 * remembered approvals or `covers` say: answer `true` for a call whose exact
	 * input was not shown in full, or that is too large to show. It is asked
	 * first, for each waiting call, and a `true` (or a failure) keeps the
	 * question open. It does not stop a call from being asked about up front.
	 */
	readonly neverCover?: (call: ToolCallSummary) => boolean | Promise<boolean>
	/**
	 * The calls (by id) that must be asked about together, in one request, before
	 * any call of the batch starts: a question about the whole batch rather than
	 * about one call, such as the first look at the screen. A yes approves those
	 * calls; a No refuses them. Absent, nothing is asked together.
	 */
	readonly askTogether?: (calls: readonly ToolCallSummary[]) => readonly string[]
}

export type ResumeHandler = (
	request: HITLDecisionRequest,
	context?: ResumeContext,
) => Promise<HITLResumeDecision>

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
		/**
		 * A rule written to ask a person (a `review` rule), or a hook that asked
		 * for one, requested this review. Like {@link explicitReview}, it is not
		 * set when an `allow` rule was demoted to review because the call reaches
		 * past its boundary. `bypass` and `classify` keep this question for a
		 * person; they answer the demoted kind themselves.
		 */
		askRule?: true
		/**
		 * How wide the `allow` rule that settled this call is. `tool` means the
		 * rule names the whole tool, a category, a tier or a source, or its
		 * pattern matches every input; `pattern` means it matches some inputs
		 * only. Present only when `decision` is `allow` and a rule (not the
		 * read-only allowance) decided it. The `classify` review mode reads it:
		 * a whole-tool allow for a shell tool would let the classifier never
		 * see a command.
		 */
		allowScope?: 'tool' | 'pattern'
	}
	/**
	 * What this call reaches beyond the turn's ordinary boundary, as the
	 * kernel found it in the prepared input. Absent for the ordinary call.
	 *
	 * A call carrying one is always reviewed: an `allow` rule, a remembered
	 * grant, a read-only declaration and `accept-edits` all decline to
	 * approve it on their own. A `deny` rule still refuses it outright.
	 */
	escalation?: ToolCallEscalation
	/**
	 * The tool itself declared that this exact call always needs a person's
	 * approval (`ToolDefinition.requiresApproval`), regardless of the host's
	 * rules or the turn's mode.
	 *
	 * Computed once, when the batch is prepared for review, the same way
	 * {@link isDestructive} is — so it survives a gate `allow` rule (the
	 * decision is forced back to `review` before the rule can settle
	 * anything) and is asked about, or refused unattended, in every mode,
	 * like {@link escalation}. No grant, skill grant or `accept-edits`
	 * exemption covers it, and a `deny` rule still wins.
	 */
	requiresApproval?: true
	/**
	 * Present when a skill loaded earlier in this turn pre-approved this call
	 * through its `allowed-tools`, and nothing stronger stands in the way.
	 *
	 * Marked only on a call the operator's policy left to review (no `deny`,
	 * no explicit `ask` rule), that is not destructive and that carries no
	 * {@link escalation}. The review policy decides what the mark is worth:
	 * `createReviewHandler` approves a batch without asking when every call
	 * it would have asked about carries one, and still refuses under `plan`
	 * and `strict`. A host's own handler may ignore it.
	 */
	skillGrant?: { readonly skill: string }
	/**
	 * What a `pre_tool_use` hook answered about approving this call, as the
	 * hooks reported it. `ask` is acted on by the kernel (it makes the call an
	 * explicit review); `allow` is acted on only through {@link hookGrant}.
	 */
	hookPermission?: {
		readonly decision: 'allow' | 'ask'
		readonly reason?: string
	}
	/**
	 * Present when a `pre_tool_use` hook said `allow` and nothing stronger
	 * stands in the way.
	 *
	 * Marked on the same terms as {@link skillGrant}: only a call the
	 * operator's policy left to review (no `deny`, no explicit `ask` rule, no
	 * hook `ask`), that is not destructive, carries no {@link escalation} and
	 * is not one the tool always asks about. A sandbox escape, a path outside
	 * the roots, a tool's own `requiresApproval`, a rule's review and the
	 * dangerous-pattern floor therefore all still reach a person, or refuse.
	 * `plan` and `strict` refuse a marked call exactly as they refuse any other.
	 */
	hookGrant?: { readonly reason?: string }
}

/** See {@link ToolCallSummary.escalation}. */
export interface ToolCallEscalation {
	/**
	 * Absolute paths the call names outside the working directory and the
	 * added directories. Present only when the turn reviews such paths
	 * (`QueryParams.outsideRootAccess: 'review'`) and runs without a sandbox;
	 * an approval lets this call, and only this call, reach them.
	 */
	outsidePaths?: readonly string[]
	/**
	 * The call asks to run outside the turn's sandbox. Present only when the
	 * turn has a sandbox and allows escapes (`QueryParams.sandboxEscape:
	 * 'review'`). Honoured only when the decision lists the call's id in
	 * `confirmedEscalations`.
	 */
	sandboxEscape?: true
	/**
	 * Why a command's own program name — where `programPositions` (the SDK's
	 * shared resolver for where a command line actually execs a program;
	 * `packages/sdk/src/authorization/program.ts`) says one is actually
	 * exec'd, after unwrapping any `sudo`/`env`/`nice`/`timeout`/…
	 * re-exec chain, and independently for each `find -exec` clause — is not
	 * knowable ahead of running it: the word itself is decided at runtime
	 * (`$(echo rm) -rf x`, `env $(echo git) push`, `"$HOME"/bin/tool`), an
	 * option on a wrapper this does not recognise stood in the way, the
	 * position is inherently unreadable (`eval`/`source`/`.`, an `xargs`
	 * program that is a shell or a `{}` placeholder), or an earlier command
	 * set `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV` or `IFS`
	 * so even a literal name here cannot be trusted to resolve to what its
	 * text says.
	 *
	 * No rule can be trusted to have matched a program whose name never
	 * appears as such anywhere in the call's own text: `git push.*` does not
	 * see `$(echo git) push`, and neither `env $(echo git) push` nor
	 * `timeout 5 $(echo git) push` puts the program right after the wrapper's
	 * own name. Present only for a tool that declares `commandArgument`.
	 * Argument-level expansion alone does not set this — only a position
	 * where a program name is actually decided.
	 */
	unknownProgram?: string
	/**
	 * Absolute paths this call writes that are protected in every mode: git
	 * hooks and config, shell rc files, editor and tool configuration, the
	 * project's own `.namzu` directory (see `authorization/protected-paths.ts`
	 * for the list). A write there plants something that runs later, outside
	 * the turn, so it is asked about every time and refused when nobody can be
	 * asked; no rule, mode or remembered approval covers it. Set for the file
	 * tools' declared path and for the visible write targets of a shell line:
	 * output redirections, and the operands of `cp`, `mv`, `tee`, `touch`,
	 * `mkdir`, `rm`, `rmdir` and `sed -i`.
	 */
	protectedPaths?: readonly string[]
	/**
	 * Why a shell line removes something it must not: the file system root, a
	 * top-level directory, the home directory, the working directory or one of
	 * its parents, a glob that crosses directories, or a target a variable or
	 * substitution may empty. The flags do not matter, only the targets. Asked
	 * about every time and refused when nobody can be asked. Present only for a
	 * tool that declares `commandArgument`.
	 */
	dangerousRemoval?: string
	/**
	 * Why the kernel could not finish looking at this call: the check that
	 * finds the escalations above threw, so none of them is known to be
	 * absent. Treated as the most serious escalation there is, because the
	 * safety checks did not run: a person is asked in every mode, `bypass`
	 * and `classify` included, and it is refused when nobody can be asked.
	 */
	unfinishedCheck?: string
}

export interface ToolModification {
	toolCallId: string
	action: 'approve' | 'deny' | 'modify'
	modifiedInput?: unknown
}

export interface UserQuestionOption {
	id: string
	/**
	 * The label as shown and as the answer quotes it. `ask_user_question`
	 * takes out of it a recommendation marker the model wrote out of habit:
	 * "(Recommended)" on any option, and "(Önerilen)", "(Empfohlen)", … on
	 * a recommended option, when every option whose label ends in a
	 * parenthesised group is recommended, did not end in "(Recommended)", and
	 * ends in that same one. A group that differs between options, or is left
	 * before "(Recommended)" ("Cloud (AWS) (Recommended)" → "Cloud (AWS)"),
	 * is kept. The recommendation is `recommended`, so a host never has to
	 * parse a label to find it. Apart from surrounding spaces and
	 * "(Recommended)", an option that is not recommended keeps its label as
	 * written.
	 */
	label: string
	description?: string
	/**
	 * The model recommends this option: it set `recommended: true` on it, or
	 * left the flag out and ended the label in "(Recommended)". A host marks
	 * it (a badge, an emphasis) rather than relying on the label to say so.
	 * Absent, not `false`, on every other option.
	 */
	recommended?: boolean
	/**
	 * Plain text or markdown a host may show beside the option list while this
	 * option is focused (a snippet, a mock-up, a side-by-side). Optional and
	 * never required to answer; a host that has nowhere to show it ignores it.
	 */
	preview?: string
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
	/**
	 * Present when one `ask_user_question` call carries several related
	 * questions (two to four; a single question leaves this out). The
	 * top-level `question`, `header`, `options`, `multiSelect` and
	 * `allowFreeText` then mirror the FIRST entry, so a host that does not
	 * know this field still shows a coherent question and answers it; the
	 * rest read as unanswered.
	 *
	 * A host shows all of them together, collects every answer, and returns
	 * one {@link UserQuestionAnswer} per question it has an answer for through
	 * `answer_question.answers`.
	 */
	questions?: readonly UserQuestionItem[]
}

/**
 * One question of a batch. `id` is stable: the asking `tool_use_id`, `#`, and
 * the question's zero-based position, so an answer names the question it
 * belongs to even when a host shows them in another order.
 */
export interface UserQuestionItem {
	id: string
	question: string
	header?: string
	options: UserQuestionOption[]
	multiSelect: boolean
	allowFreeText: boolean
}

/**
 * The answer to one question of a batch. A question with no entry was not
 * answered; an entry with no selection and no text counts the same.
 */
export interface UserQuestionAnswer {
	/** {@link UserQuestionItem.id}. */
	questionId: string
	selectedOptionIds: string[]
	freeText?: string
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
			// Headless turns must never deadlock on a question and must
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
