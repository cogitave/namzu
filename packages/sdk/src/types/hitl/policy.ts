import type { RunId } from '../ids/index.js'
import type { ResumeHandler } from './index.js'

/**
 * Who answers when the run asks a human, as a value rather than a closure.
 *
 * `ResumeHandler` was captured once at `query()` start and never read again
 * from anywhere a host could reach — so switching from "ask me about every
 * write" to "go ahead, I'm stepping out" meant ending the run and starting
 * another. That is the same defect `permissionMode` had before it became a
 * box the executor reads through, and it has the same cost: the fix
 * discards the in-flight step and the context that step was built from.
 *
 * The `name` is not decoration. A durable log entry saying a policy changed
 * is useless if the only thing it can print is `[Function (anonymous)]`,
 * and this event exists to answer "who approved that, and under what rule"
 * months later.
 */
export interface ApprovalPolicy {
	/**
	 * A stable name for this policy — `auto-approve`, `operator-tui`,
	 * `deny-all`. Written to the durable log and shown to an operator.
	 */
	readonly name: string
	readonly handler: ResumeHandler
}

/**
 * The policy RIGHT NOW, plus the only supported way to change it.
 *
 * `set` is async because the change is durably recorded before it takes
 * effect, and that ordering is deliberate: a policy that started approving
 * writes before the record landed would leave a log where the approvals
 * precede the decision that permitted them.
 */
export interface RunApprovalPolicy {
	readonly current: ApprovalPolicy
	/**
	 * Swap the policy, recording who and why.
	 *
	 * `reason` is required rather than optional. Every field here is read by
	 * somebody reconstructing an incident, and an optional reason is a field
	 * that is absent exactly when it matters most — the change nobody
	 * expected.
	 */
	set(policy: ApprovalPolicy, reason: string): Promise<void>
}

/** The durable record of a policy change. */
export interface ApprovalPolicyChangedEvent {
	readonly type: 'approval_policy_changed'
	readonly runId: RunId
	readonly from: string
	readonly to: string
	readonly reason: string
}
