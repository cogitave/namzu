import type {
	ApprovalPolicy,
	ApprovalPolicyChange,
	RunApprovalPolicy,
} from '../../types/hitl/policy.js'
import type { RunId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/index.js'

/**
 * The run's approval policy, as a box the run reads through.
 *
 * Every call site that used to close over `params.resumeHandler` reads
 * `.current.handler` instead, which is the entire mechanism: a closure
 * captured at `query()` start cannot be changed without ending the run, and
 * ending the run to change one setting discards the in-flight step and the
 * context it was built from. `permissionMode` learned this first and is the
 * shape this follows.
 */

/** A policy that says yes to everything, named so a log can say so. */
export const AUTO_APPROVE_POLICY_NAME = 'auto-approve'

export interface CreateRunApprovalPolicyOptions {
	readonly runId: RunId
	readonly initial: ApprovalPolicy
	readonly emit: (event: RunEvent) => Promise<void>
}

export function createRunApprovalPolicy(
	options: CreateRunApprovalPolicyOptions,
): RunApprovalPolicy {
	let current = options.initial
	let unannounced: ApprovalPolicyChange | undefined
	return {
		get current(): ApprovalPolicy {
			// A getter, not a field. A caller holding this object across a
			// change must see the change; a captured field would hand back the
			// policy that was current when it looked, which is the defect this
			// whole box exists to remove.
			return current
		},
		async set(policy: ApprovalPolicy, reason: string): Promise<void> {
			if (policy.name === current.name && policy.handler === current.handler) {
				// A no-op change is not an event. A log line saying the policy
				// changed from `operator-tui` to `operator-tui` teaches a reader
				// that these entries can be noise, and the one that matters is
				// then one of many.
				return
			}
			const from = current.name
			// Recorded BEFORE it takes effect. Swap first and the log reads as
			// approvals that precede the decision permitting them — which is
			// exactly backwards for the one question this event is kept to
			// answer.
			await options.emit({
				type: 'approval_policy_changed',
				runId: options.runId,
				from,
				to: policy.name,
				reason,
			})
			current = policy
			// Overwritten, not queued. Three swaps between two model calls are
			// one fact by the time the model can act on one — replaying the
			// intermediate ones would describe a history where the model needs
			// a state. The `from` is preserved from the ORIGINAL unannounced
			// change, so a model told once about A→B→C hears A→C, which is the
			// true statement about what it is under now versus what it planned
			// under.
			unannounced = { from: unannounced?.from ?? from, to: policy.name, reason }
		},
		takeUnannouncedChange(): ApprovalPolicyChange | undefined {
			const change = unannounced
			unannounced = undefined
			return change
		},
	}
}
