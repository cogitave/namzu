import type { HITLResumeDecision, ToolCallSummary } from '../../../types/hitl/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { GateEvaluationResult } from '../../../types/verification/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import type { Logger } from '../../../utils/logger.js'
import { type VerificationGate, gateDenialOutput } from '../../../verification/index.js'

export type ProviderToolCall = NonNullable<ChatCompletionResponse['message']['toolCalls']>[number]

/**
 * A call that survived the deny plane.
 *
 * The human is shown these and only these; the executor is driven from these and only
 * these. A gate-denied call never becomes one, so no human decision — not
 * `approve_tools`, not a `modify` that names its id — has anything to reach for. That
 * is the whole point of the type: "the batch the human approved" and "the batch the
 * model asked for" are no longer the same value.
 */
export interface ReviewableCall {
	readonly call: ProviderToolCall
	readonly summary: ToolCallSummary
	readonly decision: 'allow' | 'review'
}

/** A call that will not run, and the result the model is answered with instead. */
export interface Denial {
	readonly toolCallId: string
	readonly output: string
}

export interface AppliedOutcome {
	/** Calls to dispatch. */
	readonly approved: ProviderToolCall[]
	/**
	 * Results to write for calls that will NOT run. Every reviewed call ends up in
	 * exactly one of `approved` or `denials` — which is what keeps the assistant's
	 * tool-call block provider-valid no matter what the human decided.
	 */
	readonly denials: Denial[]
	/** A `[SYSTEM]` note for the model explaining a wholesale rejection, if any. */
	readonly systemNote?: string
}

/**
 * Gate evaluation that denies when it breaks
 * ([fail-closed-gates](../../../../../docs.local/conventions/fail-closed-gates.md)).
 *
 * A rule is a predicate over an input shape it did not choose, and the gate exists to
 * say no, so "this check crashed" must not read as "this check approved". It must not
 * take the run down either: the caller answers the model with a denial result instead.
 *
 * This is the gate that decides **what a human is asked** and **what a human's decision
 * is allowed to become**. It is NOT what makes a denial safe. The authoritative check
 * runs at the dispatch point, in `ToolExecutor.denyFinalInput`, against the input that
 * can no longer change
 * ([authorize-what-runs](../../../../../docs.local/conventions/authorize-what-runs.md)).
 */
export function evaluateGate(
	gate: VerificationGate,
	tools: ToolRegistryContract,
	log: Logger,
	toolName: string,
	toolInput: unknown,
): GateEvaluationResult {
	try {
		return gate.evaluate({ toolName, toolInput, toolDef: tools.get(toolName) })
	} catch (err) {
		log.error('Verification gate threw while evaluating a tool call — denying', {
			tool: toolName,
			error: toErrorMessage(err),
		})
		return { decision: 'deny', matchedRule: null, reason: 'Verification gate error' }
	}
}

/**
 * Turn a reviewer's outcome into "what runs" and "what is answered with a denial".
 *
 * **One implementation, two callers**, and that is the point. The live review phase
 * applies an outcome that arrived from an in-process handler; the resume dispatcher
 * applies one that was persisted hours ago and redeemed over the wire. If those two
 * grew separate copies of this logic, the durable path would be the one that quietly
 * lost the modified-input re-gate — and `171f339` is the commit that proves how that
 * ends. A human `modify` is a *new call*, authorized as one, wherever it arrives from.
 *
 * Every reviewed call lands in exactly one of `approved` or `denials`. That invariant
 * is what keeps the assistant's tool-call block provider-valid: an unanswered call is a
 * history no provider will accept, and leaving one behind is how the pre-ses_017
 * `reject_tools` path produced an invalid history on the very next model call.
 */
export function applyReviewOutcome(args: {
	reviewable: readonly ReviewableCall[]
	outcome: HITLResumeDecision
	gate?: VerificationGate
	tools: ToolRegistryContract
	log: Logger
}): AppliedOutcome {
	const { reviewable, outcome, gate, tools, log } = args

	switch (outcome.action) {
		case 'reject_tools': {
			const feedback = outcome.feedback || 'User rejected the tool calls'
			return {
				approved: [],
				// Pre-ses_017 this path wrote NO tool results and pushed only the user
				// note, leaving the assistant's tool-call block unanswered — a history
				// every provider rejects, sent on the very next iteration. A rejection is
				// still a dispatch outcome: each call gets an answer.
				denials: reviewable.map((rc) => ({
					toolCallId: rc.call.id,
					output: `Error: Tool call "${rc.summary.name}" rejected by user: ${feedback}`,
				})),
				systemNote: `[SYSTEM] Tool calls rejected: ${feedback}`,
			}
		}

		case 'modify_tools': {
			const modifications = new Map(outcome.modifications.map((mod) => [mod.toolCallId, mod]))
			const approved: ProviderToolCall[] = []
			const denials: Denial[] = []

			for (const rc of reviewable) {
				const mod = modifications.get(rc.call.id)

				if (mod?.action === 'deny') {
					denials.push({
						toolCallId: rc.call.id,
						output: `Error: Tool call "${rc.summary.name}" denied by user`,
					})
					continue
				}

				if (mod?.action === 'modify' && mod.modifiedInput !== undefined) {
					// The gate saw the input the model wrote, not the one about to run. A
					// modification is a new call and is authorized as one — a benign call the
					// human approved must not become a denied operation by way of a typo, a
					// compromised client, or a malicious modify payload.
					//
					// `ToolExecutor.denyFinalInput` would catch this one too, and that is the
					// check safety rests on. This one is kept because it changes the DECISION,
					// not just the outcome: a denied modification is dropped from the approved
					// set here, so if nothing survives, the phase ends as 'rejected' with the
					// model told why — rather than dispatching a batch that is guaranteed to
					// come back denied.
					if (gate) {
						const verdict = evaluateGate(gate, tools, log, rc.summary.name, mod.modifiedInput)
						if (verdict.decision === 'deny') {
							log.warn(
								'Verification gate: modified tool call denied — modification rejected, not executing',
								{ tool: rc.summary.name, reason: verdict.reason },
							)
							denials.push({
								toolCallId: rc.call.id,
								output: gateDenialOutput(rc.summary.name, verdict.reason),
							})
							continue
						}
					}
					rc.call.function.arguments = JSON.stringify(mod.modifiedInput)
				}

				approved.push(rc.call)
			}

			return {
				approved,
				denials,
				systemNote:
					approved.length === 0 ? '[SYSTEM] All tool calls were denied by user' : undefined,
			}
		}

		case 'approve_tools':
		case 'continue':
			return { approved: reviewable.map((rc) => rc.call), denials: [] }

		default:
			// `pause`, `abort` and the plan actions are not outcomes that *dispatch* a
			// batch — the caller handles them before it gets here, and a durable outcome
			// is validated against its request type before it is ever recorded. Reaching
			// this line means a caller applied an outcome it had no business applying, and
			// approving the batch by default would be the fail-open reading of a bug.
			return {
				approved: [],
				denials: reviewable.map((rc) => ({
					toolCallId: rc.call.id,
					output: `Error: Tool call "${rc.summary.name}" not executed — unsupported review outcome '${outcome.action}'`,
				})),
				systemNote: `[SYSTEM] Tool calls not executed: unsupported review outcome '${outcome.action}'`,
			}
	}
}

/**
 * Which outcomes may legitimately answer which request?
 *
 * A durable decision arrives over a wire, from a client that may be buggy or hostile,
 * and is recorded before anything acts on it. Selecting `approve_plan` to answer a tool
 * review, or answering an already-paused review with `pause`, would either be applied
 * as something it is not or park a run that can never be answered again — the token is
 * spent, so a "still pending" outcome strands the run for good. Validated at redemption,
 * where it can still be refused.
 */
export function isValidOutcomeFor(
	requestType: 'plan_approval' | 'tool_review' | 'iteration_checkpoint',
	action: HITLResumeDecision['action'],
): boolean {
	switch (requestType) {
		case 'tool_review':
			return (
				action === 'approve_tools' ||
				action === 'modify_tools' ||
				action === 'reject_tools' ||
				action === 'continue' ||
				action === 'abort'
			)
		case 'plan_approval':
			return action === 'approve_plan' || action === 'reject_plan' || action === 'abort'
		case 'iteration_checkpoint':
			return action === 'continue' || action === 'abort'
		default:
			return false
	}
}
