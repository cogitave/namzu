/**
 * How a run resolves the calls no rule decided.
 *
 * An authorization rule says what a tool may do. A review policy says what
 * happens to everything the rules did not cover: the batch the gate routed
 * to REVIEW. The two axes are separate on purpose — a rule is a durable
 * statement an operator reviewed, and a mode is a property of ONE run, the
 * difference between "we never force-push" and "this run is unattended".
 *
 * Only calls the gate routed to review arrive here. A rule that denied one
 * already stopped it, and a rule that allowed one never asked. So a mode
 * decides the undecided and can never reopen what a rule closed; a host's
 * `--permission-mode` flag cannot widen a `deny`. That is the whole
 * precedence story between a flag and a config file, in one sentence.
 *
 * This lived in the operator application as one closure. It moved here
 * because none of it is about a terminal: the modes name kernel tools, the
 * exemptions reason about kernel tools' blast radius, and a second host
 * would otherwise write the same five branches and drift on the sixth.
 * What a host supplies is the one thing the kernel cannot: how to ask a
 * person (`prompt`).
 */

import type { ToolRegistry } from '../../registry/tool/execute.js'
import { isTrustedReadOnly } from '../../tools/trusted-read-only.js'
import type { HITLResumeDecision, ResumeHandler, ToolCallSummary } from '../../types/hitl/index.js'
import type { ApprovalPolicy } from '../../types/hitl/policy.js'

export type ReviewMode =
	/** Ask a person. The default when a `prompt` is supplied. */
	| 'prompt'
	/** Approve it. The default without a `prompt`, and what every headless run has always done. */
	| 'auto'
	/**
	 * Approve a file edit, ask about everything else.
	 *
	 * The mode an operator watching the agent write code actually wants: an
	 * `edit` or `write` inside the working directory is what they asked for
	 * and is undoable with `git`, so a prompt on each one is a prompt they
	 * answer `y` to forty times an hour — and a prompt that is always
	 * answered the same way trains the hand to answer the next one, which is
	 * the shell prompt, the same way. Shell commands, delegation and anything
	 * a tool declares destructive still ask.
	 */
	| 'accept-edits'
	/**
	 * Read and think, do not act. A call that only reads is approved; a call
	 * that would change anything is refused with feedback telling the model
	 * to present its plan instead. The operator reads the plan and switches
	 * mode to have it carried out — the switch IS the approval. The kernel's
	 * `permissionMode: 'plan'` is the floor under this: it blocks a mutating
	 * call at execution with no feedback, where this refuses it at review
	 * with the words that make the model plan.
	 */
	| 'plan'
	/**
	 * Refuse it. Nothing runs unless a rule allowed it by name or pattern —
	 * the allowlist is the whole permission surface, which is the only form
	 * an unattended run can actually be reasoned about.
	 */
	| 'strict'

export const REVIEW_MODES: readonly ReviewMode[] = [
	'prompt',
	'accept-edits',
	'auto',
	'strict',
	'plan',
]

export function isReviewMode(value: unknown): value is ReviewMode {
	return typeof value === 'string' && (REVIEW_MODES as readonly string[]).includes(value)
}

/** What the model is told when a call is refused under `plan`. */
export const PLAN_MODE_REFUSAL =
	'Refused: plan mode is read-only. Explore with the reading tools, then present the plan as your reply — what you would change, in which files, and in what order. The user will switch out of plan mode to have it carried out.'

/** What the model is told when a call is refused under `strict`. */
export const STRICT_MODE_REFUSAL =
	'Refused: this run only permits tools an explicit rule allows, and no rule covers this call. Asking again will not change it — either the operator adds a rule, or this has to be done another way.'

/** The tools `accept-edits` approves without asking. Everything else prompts. */
export const ACCEPT_EDITS_TOOLS: ReadonlySet<string> = new Set(['edit', 'write'])

/**
 * Writes that skip review anyway, in spite of declaring `readOnly: false`.
 *
 * This is an OVERRIDE of the tool's own declaration, and it is named as one.
 * The bar for an entry is that prompting would be unusable AND a bad write
 * cannot reach beyond the agent's own bookkeeping:
 *
 * - `task_create` / `task_update` / `update_goal` — the model's own plan for
 *   the current request, written several times per planning turn; asking
 *   each time would put a consent dialog between the agent and its todo
 *   list. What a bad write costs is a polluted task list, visible in the
 *   transcript, and it grants nothing.
 *
 * `save_memory` is deliberately NOT here. Content saved now is retrievable
 * by `search_memory` in a later session, so a tool result that talks the
 * model into saving something reaches a future run's reasoning. A write
 * that survives the process is not read-only under any reading.
 */
export const REVIEW_EXEMPT_WRITES: ReadonlySet<string> = new Set([
	'task_create',
	'task_update',
	'update_goal',
])

/**
 * Whether a call runs without review: it declares itself read-only and is
 * trusted to say so, or it is a named exemption above.
 *
 * The read-only half comes from the tool's own declaration through
 * `isTrustedReadOnly`, the predicate the authorization gate uses, never from
 * a list of names kept here: a renamed tool would otherwise change posture
 * with nothing to notice. A fetch declares itself read-only and is still a
 * request leaving the machine to an address the model chose, so `network`
 * tools are reviewed like a shell command. A tool the registry does not
 * know, or one that declares nothing, is reviewed.
 */
export function isReviewExempt(
	registry: Pick<ToolRegistry, 'get'>,
	name: string,
	input: unknown,
): boolean {
	if (REVIEW_EXEMPT_WRITES.has(name.toLowerCase())) return true
	const tool = registry.get(name) ?? registry.get(name.toLowerCase())
	if (tool?.category === 'network') return false
	return isTrustedReadOnly(tool, input)
}

export type ReviewExemption = (name: string, input: unknown) => boolean

/** A batch needs review when any call mutates state: flagged destructive, or not exempt. */
export function batchNeedsReview(
	toolCalls: readonly ToolCallSummary[],
	exempt: ReviewExemption,
): boolean {
	return toolCalls.some((tc) => tc.isDestructive || !exempt(tc.name, tc.input))
}

/** The batch a person is asked about. */
export interface ToolReviewRequest {
	readonly toolCalls: readonly ToolCallSummary[]
}

export type ToolReviewAnswer =
	| { readonly kind: 'approve' }
	/** Approve, and stop asking for the rest of the run. */
	| { readonly kind: 'approve-all' }
	| { readonly kind: 'reject'; readonly feedback?: string }

/** How a host asks a person. The one thing the kernel cannot supply. */
export type ToolReviewPrompt = (request: ToolReviewRequest) => Promise<ToolReviewAnswer>

export interface ReviewPolicyOptions {
	/** Default `prompt` when a `prompt` is supplied, `auto` otherwise. */
	readonly mode?: ReviewMode
	readonly prompt?: ToolReviewPrompt
	/** Which calls skip review; default `isReviewExempt` over `registry`, or nothing without one. */
	readonly exempt?: ReviewExemption
	readonly registry?: Pick<ToolRegistry, 'get'>
	/**
	 * Where "approve all" is remembered. A host that shows the state (a
	 * badge saying the session is unattended) passes its own box so both
	 * read the same fact; omitted, the policy keeps one privately.
	 */
	readonly remembered?: { all: boolean }
}

/** The handler behind `createReviewPolicy`, for a host that wants only the function. */
export function createReviewHandler(options: ReviewPolicyOptions = {}): ResumeHandler {
	const { prompt, registry } = options
	const mode: ReviewMode = options.mode ?? (prompt ? 'prompt' : 'auto')
	const exempt: ReviewExemption =
		options.exempt ??
		(registry ? (name, input) => isReviewExempt(registry, name, input) : () => false)
	const remembered = options.remembered ?? { all: false }
	return async (request): Promise<HITLResumeDecision> => {
		if (request.type !== 'tool_review') {
			return request.type === 'plan_approval' ? { action: 'approve_plan' } : { action: 'continue' }
		}
		if (!batchNeedsReview(request.toolCalls, exempt)) {
			return { action: 'approve_tools' }
		}
		// A batch of nothing but non-destructive file edits is the case
		// `accept-edits` exists for. One shell call in the same batch and the
		// whole batch asks — the operator reviews the batch as a unit, and a
		// prompt that showed only the shell command while the edits went
		// through beside it would be approving something it did not show.
		if (
			mode === 'accept-edits' &&
			request.toolCalls.every(
				(tc) => !tc.isDestructive && (ACCEPT_EDITS_TOOLS.has(tc.name) || exempt(tc.name, tc.input)),
			)
		) {
			return { action: 'approve_tools' }
		}
		// Reads were approved above. Anything that reached here would change
		// something, and plan mode's answer is the same every time: not now,
		// tell the user what you would do.
		if (mode === 'plan') return { action: 'reject_tools', feedback: PLAN_MODE_REFUSAL }
		if (mode === 'strict') return { action: 'reject_tools', feedback: STRICT_MODE_REFUSAL }
		if (mode === 'auto' || !prompt || remembered.all) {
			return { action: 'approve_tools' }
		}
		const answer = await prompt({ toolCalls: request.toolCalls })
		switch (answer.kind) {
			case 'approve':
				return { action: 'approve_tools' }
			case 'approve-all':
				remembered.all = true
				return { action: 'approve_tools' }
			case 'reject':
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? 'User declined to run the proposed tool(s).',
				}
		}
	}
}

/**
 * The mode as an `ApprovalPolicy`, named after itself so a durable log can
 * say which one approved a call. Swap it on a run's `RunApprovalPolicy`
 * to change mode without ending the run.
 */
export function createReviewPolicy(options: ReviewPolicyOptions = {}): ApprovalPolicy {
	const mode: ReviewMode = options.mode ?? (options.prompt ? 'prompt' : 'auto')
	return { name: mode, handler: createReviewHandler({ ...options, mode }) }
}
