import type { HITLResumeDecision, ToolCallSummary } from '../../types/hitl/index.js'

/**
 * A tool batch, on its way to a human sitting in front of an editor.
 *
 * The kernel's own `ToolCallSummary`, not a re-declared one: this is the
 * shape the HITL path already produces, and a copy would be a second
 * definition of "which calls am I being asked about" that can drift from the
 * one the run actually parked on.
 */
export interface AcpPermissionRequest {
	readonly sessionId: string
	readonly toolCalls: readonly ToolCallSummary[]
}

/**
 * What the human said.
 *
 * Three outcomes, matching what a human can actually mean about a batch of
 * calls: run it, run it and stop asking, or do not run it and here is why.
 * `reject` carries optional feedback because a denial with a reason is the
 * one a model can act on — "no, use the staging bucket" redirects a run,
 * where a bare denial only ends it.
 */
export type AcpPermissionOutcome =
	| { readonly kind: 'approve' }
	| { readonly kind: 'approve_all' }
	| { readonly kind: 'reject'; readonly feedback?: string }

export type AcpPermissionAsker = (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>

/**
 * The default a denial carries when the client sent none.
 *
 * Something rather than an empty string, because this text reaches the MODEL
 * as a `reject_tools` feedback and an empty one reads as a tool that failed
 * for no reason — the model retries it. Naming the human is what makes the
 * next turn take a different path.
 */
export const ACP_DEFAULT_REJECTION = 'The person operating this session declined these tool calls.'

/**
 * One outcome as a kernel decision.
 *
 * A table, in one place, because the mapping is where a permission bridge
 * goes wrong: `approve_all` collapsing into `approve` means the latch never
 * takes and the human is asked again on every batch; `reject` collapsing
 * into `continue` means the denial is DISCARDED and the calls run anyway.
 * Both are silent.
 */
export function toResumeDecision(
	outcome: AcpPermissionOutcome,
	grantKeys: readonly string[],
): HITLResumeDecision {
	switch (outcome.kind) {
		case 'approve':
			// No `remember`. Consent is not transferable: this batch was
			// approved, and the next one is a new question.
			return { action: 'approve_tools' }
		case 'approve_all':
			// The keys ARE the latch. `approve_tools` with nothing remembered is
			// indistinguishable from a plain approve, which is exactly how an
			// "approve all" that never takes gets shipped.
			return { action: 'approve_tools', remember: grantKeys }
		case 'reject':
			return {
				action: 'reject_tools',
				feedback: outcome.feedback?.trim() || ACP_DEFAULT_REJECTION,
			}
	}
}
