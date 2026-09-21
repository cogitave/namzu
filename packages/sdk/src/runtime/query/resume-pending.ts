import { isDeepStrictEqual } from 'node:util'

import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import type {
	CheckpointId,
	HITLDecisionRequest,
	HITLResumeDecision,
	ToolCallSummary,
} from '../../types/hitl/index.js'
import type { AssistantMessage, Message, ToolCall } from '../../types/message/index.js'
import type { ChatCompletionResponse } from '../../types/provider/index.js'
import type { ToolExecutionSnapshot } from '../../types/session/tool-execution.js'
import type { Logger } from '../../utils/logger.js'
import type { RestoredCheckpoint } from './checkpoint.js'
import type { PriorToolResults, ToolCallDenials, ToolExecutor } from './executor.js'
import { PendingAnswers } from './question-park.js'
import { readToolExecutions } from './tool-executions.js'
import { isPauseForCall } from './tool-pause.js'

/**
 * Apply a decision collected out-of-band to the tool calls a run parked on.
 *
 * This is the half of durable HITL that actually pays off. Recording the
 * park makes the request survive a restart; without this, a resumed run
 * still threw the approval away — the restore path repairs the unanswered
 * `tool_use` blocks and lets the model re-decide, so a human's "yes, delete
 * that row" became "ask the model again and hope it asks for the same
 * thing". The tool calls the human approved are right there in the
 * checkpoint; the decision applies to THOSE, or it means nothing.
 *
 * Returns `null` when there is nothing to apply, in which case the caller
 * keeps the existing repair-and-re-decide behavior.
 */
export interface PendingResumePlan {
	/**
	 * What produced this plan, and therefore whether it carries the human's
	 * decision out or stands in for it.
	 *
	 * `'decision'` — the answer, applied to the calls the park was about.
	 * `'recovery'` — the checkpoint's recorded and explicitly unknown outcomes,
	 * replayed so that nothing runs twice. The caller resolves the park in both
	 * cases — recovery answering the batch is what makes the question moot —
	 * but only the first may write the human's decision down as what ended it.
	 * Recording a decision recovery stood in for says the run carried out
	 * something it did not.
	 */
	readonly source: 'decision' | 'recovery'
	/**
	 * The checkpoint the park was recorded on, so the caller can clear it
	 * once the decision has actually been applied. Leaving it outstanding
	 * makes an approval queue re-serve a destructive call that already ran.
	 */
	readonly checkpointId: CheckpointId
	/** The assistant turn whose `tool_use` blocks are unanswered. */
	readonly assistant: AssistantMessage
	/** Synthesized response the executor consumes. */
	readonly response: ChatCompletionResponse
	/** Per-call refusals derived from the decision. */
	readonly denials: ToolCallDenials
	/** Exact projections and gate decisions persisted with a tool review. */
	readonly reviewedCalls?: readonly ToolCallSummary[]
	/** Calls whose raw input the human replaced in the durable decision. */
	readonly modifiedCallIds?: ReadonlySet<string>
	/**
	 * Answers to deliver to tools that parked on a question, keyed by the
	 * asking call's id. Present only on a question resume.
	 */
	readonly answers?: PendingAnswers
}

/**
 * Decide whether a restored checkpoint can have `decision` applied to it
 * directly.
 *
 * Only `tool_review` parks qualify. A `plan_approval` or
 * `iteration_checkpoint` park leaves no unanswered tool calls behind, so
 * there is nothing to apply a decision TO — those resume by simply
 * continuing, which the normal path already does correctly. A
 * `user_question` park happens inside a tool's own execution, so honoring
 * it across a restart would mean re-entering that tool; it is out of scope
 * here and says so rather than pretending.
 */
export function planPendingResume(
	checkpoint: RestoredCheckpoint,
	decision: HITLResumeDecision,
	log: Logger,
): PendingResumePlan | null {
	const pending = checkpoint.pending
	if (!pending) return null

	// A question raised INSIDE a tool resumes through the same door. The
	// checkpoint was written mid-execution, so it holds the assistant turn
	// with its `tool_use` blocks unanswered — the same shape a tool-review
	// park leaves — and re-executing that batch is exactly how the asking
	// tool gets re-entered. The answer reaches it through `PendingAnswers`
	// rather than through a second question, and siblings that already
	// finished are answered from the transcript, so re-execution costs
	// nothing beyond the one tool that was waiting.
	if (pending.request.type === 'user_question') {
		return planQuestionResume(checkpoint, decision, pending.request.question.questionId, log)
	}

	if (pending.request.type !== 'tool_review') {
		log.info('Pending decision supplied for a park that leaves no tool calls to apply it to', {
			'namzu.checkpoint.id': checkpoint.id,
			'namzu.runtime.pending_type': pending.request.type,
			'namzu.runtime.decision': decision.action,
		})
		return null
	}

	const assistant = lastUnansweredBatch(checkpoint.messages)?.assistant
	if (!assistant?.toolCalls || assistant.toolCalls.length === 0) {
		log.warn('Checkpoint records a tool_review park but has no unanswered tool calls', {
			'namzu.checkpoint.id': checkpoint.id,
		})
		return null
	}

	// The human approved the calls they were SHOWN. If the checkpoint's
	// calls no longer match the recorded request, the decision does not
	// describe this state and applying it would be consent-by-coincidence.
	const recordedIds = new Set(pending.request.toolCalls.map((tc) => tc.id))
	const actualIds = assistant.toolCalls.map((tc) => tc.id)
	const mismatched = actualIds.filter((id) => !recordedIds.has(id))
	if (mismatched.length > 0 || recordedIds.size !== actualIds.length) {
		log.error('Tool calls in the checkpoint do not match the ones the decision was made about', {
			'namzu.checkpoint.id': checkpoint.id,
			'namzu.runtime.recorded': [...recordedIds],
			'namzu.runtime.actual': actualIds,
		})
		return null
	}

	const denials = derriveDenials(assistant.toolCalls, decision)
	if (!denials) return null

	return {
		source: 'decision',
		checkpointId: checkpoint.id,
		assistant,
		response: synthesizeResponse(assistant),
		denials,
		reviewedCalls: pending.request.toolCalls,
		modifiedCallIds: modifiedCallIds(decision),
	}
}

/**
 * The stable marker `supersededByRecovery` puts at the head of its reason.
 *
 * `resolvedAt` says a park ENDED; it does not say HOW, and `pause` is the
 * action both endings share — `CheckpointManager.expire` records one for a
 * park that ran out of time, this one records another for a park whose
 * question crash recovery answered instead. A reader that tests
 * `pending.decision.action` alone can tell neither from a run still holding
 * the park, and the reason is the only field left to carry the difference.
 *
 * A constant rather than a sentence written at the call site, and a PREFIX
 * rather than the whole string, because the sentence names which decision was
 * superseded — informative to a person, unstable to a comparison. A consumer
 * tests this; the tail is prose.
 *
 * Exported for the SDK's own readers. It is not on the package's public
 * surface: a new field on the recorded decision would be, and this branch
 * ships as a `patch`.
 */
export const PARK_SUPERSEDED_BY_RECOVERY = 'crash-recovery-superseded'

/** Whether a recorded decision is the supersede marker rather than an answer. */
export function isSupersededByRecovery(decision: HITLResumeDecision | undefined): boolean {
	return (
		decision?.action === 'pause' && (decision.reason ?? '').startsWith(PARK_SUPERSEDED_BY_RECOVERY)
	)
}

/**
 * What to record on a park whose batch crash recovery answered instead of the
 * decision.
 *
 * Neither half of the obvious record is honest. Writing the human's decision
 * down would say the run carried it out, when the calls it named were answered
 * with an explicitly UNKNOWN outcome and nothing they asked for happened —
 * `planPendingResume` refused that decision in the first place, which is why
 * recovery spoke at all. Writing nothing would lose the fact that somebody
 * answered, and leave `pending.decision` meaning two different things.
 *
 * The vocabulary already has one shape for "this park ended and no decision
 * was carried out": `CheckpointManager.expire` records a `pause` carrying the
 * reason, and says why it is not an `abort` ("that would read as somebody
 * having refused it"). This is that shape, with
 * {@link PARK_SUPERSEDED_BY_RECOVERY} at the head of the reason so the fact is
 * comparable rather than prose, and the decision it superseded after it so the
 * answer a human gave is still on the record.
 */
export function supersededByRecovery(decision: HITLResumeDecision): HITLResumeDecision {
	return {
		action: 'pause',
		reason: `${PARK_SUPERSEDED_BY_RECOVERY}: crash recovery answered the tool batch this park asked about, so the decision that was given (${decision.action}) was not applied.`,
	}
}

/**
 * Whether the ordinary continue path carries `decision` out for a park that
 * has no batch of tool calls to apply it to.
 *
 * {@link planPendingResume} covers the two arms whose decision has to REACH
 * something: the calls a `tool_review` park is about, and the tool a
 * `user_question` park is inside. An `iteration_checkpoint` park has neither,
 * so it produces no plan — and "no plan" must not be read as "nothing
 * happened". For this arm the decision IS the run's next move, and the loop
 * that resumes carries it out by continuing; the park it answered therefore
 * has to be resolved exactly as the other arms' are.
 *
 * The set is `handleHITLDecision`'s continue arm, deliberately: these are the
 * decisions a resumed run carries out by going on. `pause` is not among them
 * — it is "hold this, I am not answering now", which the live path leaves the
 * park standing for, and a resumed run does not honour it either. Neither are
 * `abort` and `reject_plan`: nothing on the resume path acts on them, so
 * recording one as the park's answer would say the run carried out something
 * it did not.
 */
export function isCarriedOutByContinue(decision: HITLResumeDecision): boolean {
	switch (decision.action) {
		case 'continue':
		case 'approve_tools':
		case 'modify_tools':
		case 'reject_tools':
		case 'answer_question':
			return true
		default:
			return false
	}
}

/**
 * Whether `decision` is a verdict on the question a `plan_approval` park asks.
 *
 * The plan arm was the one park `isCarriedOutByContinue` did not cover and
 * nothing else did either, so a run resumed with `{action: 'approve_plan'}`
 * completed with its park still outstanding: `findPendingCheckpoint` kept
 * serving a plan nobody was waiting on, a second resume of the FINISHED run
 * was refused `awaiting-decision`, and `prune`'s refusal to collect an
 * unresolved park left the row uncollectable — with no `hitlParkTtlMs` there
 * is no `deadlineAt`, so `expire` cannot reach it either.
 *
 * Both verdicts answer it, and that is the difference from `pause` (which
 * HOLDS the park rather than answering it, on the live path and here) and
 * from `abort` (which is not a verdict on the plan at all). What the resumed
 * run can do about the answer afterwards is a separate question and not this
 * predicate's: the record's `decision` is what the HUMAN answered, and a park
 * is not made outstanding again by the new process having no plan to act on.
 */
export function isPlanVerdict(decision: HITLResumeDecision): boolean {
	return decision.action === 'approve_plan' || decision.action === 'reject_plan'
}

/**
 * Whether a park of `type` is ANSWERED by `decision` on the resume path.
 *
 * The map from park to the decision that answers it, in one place, because
 * each arm was added by a different fix and the two that were missed were
 * missed by being absent rather than wrong. `tool_review` and `user_question`
 * are deliberately not here: their decisions have to REACH something —
 * `planPendingResume` applies them to the parked batch — and their parks are
 * resolved where that plan is applied, not by this predicate.
 *
 * "Answered" is the ordinary continue path carrying the decision out, which
 * for the cadence arm means the loop going on and for the plan arm means the
 * verdict having been given. It does not mean the run did everything the
 * decision implies — see {@link isPlanVerdict}.
 */
export function answersParkOf(
	parkType: HITLDecisionRequest['type'] | undefined,
	decision: HITLResumeDecision,
): boolean {
	switch (parkType) {
		case 'iteration_checkpoint':
			return isCarriedOutByContinue(decision)
		case 'plan_approval':
			return isPlanVerdict(decision)
		default:
			return false
	}
}

/**
 * Resume a batch that parked inside a tool asking the user a question.
 *
 * The re-entry contract, stated plainly: the batch is re-executed, the
 * asking tool is re-entered, and the recorded answer is handed to it
 * instead of a second question. Nothing else in the batch runs twice —
 * every sibling that already completed is answered from the transcript by
 * the same recovery the crash path uses.
 *
 * This is why the answer must be delivered through the tool rather than
 * appended as a message: the question was asked BY a tool, its result is
 * what the model reads, and there is no `tool_result` for that call until
 * the tool produces one. Skipping the model call and re-running the batch
 * is what makes the answer land in the slot the model is already waiting
 * on.
 */
function planQuestionResume(
	checkpoint: RestoredCheckpoint,
	decision: HITLResumeDecision,
	questionId: string,
	log: Logger,
): PendingResumePlan | null {
	const assistant = lastUnansweredBatch(checkpoint.messages)?.assistant
	if (!assistant?.toolCalls || assistant.toolCalls.length === 0) {
		log.warn('Checkpoint records a question park but has no unanswered tool calls', {
			'namzu.checkpoint.id': checkpoint.id,
		})
		return null
	}

	// The answer must belong to a call that is actually in this turn. A
	// stale client answering a question from an earlier turn would
	// otherwise have its answer delivered to whatever tool now holds that
	// slot — the misdirection the asking tool's own id guard exists to
	// prevent, checked here too because by then the tool has been entered.
	//
	// Through `isPauseForCall` rather than by equality, because a parked
	// question id is not a call id. The general seam appends the tool
	// author's pause name to it, so equality compared
	// `call_1:target_environment` against `call_1`, could never hold, and
	// refused every cross-process resume of a host-authored pause. Only
	// the built-in question tool got through, and only because it parks
	// under the bare tool-use id.
	if (!assistant.toolCalls.some((tc) => isPauseForCall(questionId, tc.id))) {
		log.error('The parked question does not belong to any unanswered call in this turn', {
			'namzu.checkpoint.id': checkpoint.id,
			'namzu.runtime.question_id': questionId,
		})
		return null
	}

	return {
		source: 'decision',
		checkpointId: checkpoint.id,
		assistant,
		response: synthesizeResponse(assistant),
		// Nothing was refused. A question is not an approval gate: the
		// answer steers the tool, it does not license it.
		denials: new Map(),
		answers: PendingAnswers.from(decision),
	}
}

/**
 * Preserve a restored batch's recorded and explicitly unknown outcomes.
 * `completed` comes from recoverCompletedCalls: missing entries are eligible
 * only after a complete scan establishes that they have no recorded start.
 * A started tool with no trustworthy completion is carried as an unknown
 * outcome, not executed again. An untouched batch uses ordinary history repair.
 */
export function planCrashResume(
	checkpoint: RestoredCheckpoint,
	completed: ReadonlyMap<string, unknown>,
	log: Logger,
): PendingResumePlan | null {
	const assistant = lastUnansweredBatch(checkpoint.messages)?.assistant
	const calls = assistant?.toolCalls
	if (!assistant || !calls || calls.length === 0) return null
	// Only the current tail can be resumed in place. An older incomplete
	// batch belongs to history repair; re-appending it would move its action
	// past a newer operator message and silently reorder the conversation.
	const ownerIndex = checkpoint.messages.lastIndexOf(assistant)
	if (checkpoint.messages.slice(ownerIndex + 1).some((message) => message.role !== 'tool'))
		return null

	const done = calls.filter((tc) => completed.has(tc.id))
	if (done.length === 0) return null

	log.warn('Checkpoint holds a tool batch that was part-way through executing', {
		'namzu.checkpoint.id': checkpoint.id,
		'namzu.runtime.recovered': done.length,
		'namzu.runtime.total': calls.length,
		'namzu.runtime.remaining': calls
			.filter((tc) => !completed.has(tc.id))
			.map((tc) => tc.function.name),
	})

	return {
		// Not the human's decision — recovery's own reading of the batch. The
		// caller resolves the park either way and must not write the decision
		// down as what ended it; see {@link supersededByRecovery}.
		source: 'recovery',
		checkpointId: checkpoint.id,
		assistant,
		response: synthesizeResponse(assistant),
		// Nothing was refused: this is a resume, not a decision.
		denials: new Map(),
	}
}

/**
 * Execute a resume plan, pushing the assistant turn and its results.
 *
 * The assistant message is re-pushed rather than repaired away, because
 * the `tool_result` blocks about to be produced must answer the `tool_use`
 * blocks that are in it — a result with no matching call is exactly the
 * malformed request the repair path exists to prevent.
 */
export async function applyPendingResume(
	plan: PendingResumePlan,
	recorder: TurnRecorder,
	executor: ToolExecutor,
	prior?: PriorToolResults,
): Promise<void> {
	const denials = new Map(plan.denials)
	const reviewedById = new Map(plan.reviewedCalls?.map((call) => [call.id, call]))

	// A gate denial belongs to the run, not to the process that first evaluated
	// it. Restore it before preparation so denied calls do not even reach a
	// pre-tool hook after restart.
	for (const call of plan.reviewedCalls ?? []) {
		if (call.authorization?.decision !== 'deny' || denials.has(call.id)) continue
		denials.set(
			call.id,
			`Blocked by the authorization gate: ${call.authorization.reason ?? 'the persisted operator policy denied this call'}`,
		)
	}

	const callsToPrepare = (plan.response.message.toolCalls ?? []).filter(
		(call) => !prior?.has(call.id) && !denials.has(call.id),
	)
	const responseToPrepare: ChatCompletionResponse = {
		...plan.response,
		message: { ...plan.response.message, toolCalls: callsToPrepare },
	}
	const preparedBatch = await executor.prepareBatchForReview(responseToPrepare)

	for (const call of preparedBatch.reviewCalls) {
		const reviewed = reviewedById.get(call.id)
		const wasModified = plan.modifiedCallIds?.has(call.id) === true
		if (reviewed && !wasModified) {
			const unchanged = reviewed.name === call.name && isDeepStrictEqual(reviewed.input, call.input)
			if (!unchanged) {
				const reason =
					'The tool input changed after its durable review; the earlier approval cannot be reused.'
				denials.set(call.id, reason)
				await recorder.recordAudit({
					what: { action: 'tool_call', tool: call.name },
					outcome: 'refused',
					reason,
				})
				continue
			}
		}

		const current = executor.evaluatePreparedAuthorization(call.name, call.input)
		let reason: string | undefined
		if (current?.decision === 'deny') {
			reason = `Blocked by the authorization gate after resume: ${current.reason}`
		} else if (current?.decision === 'review' && (wasModified || !reviewed)) {
			reason = wasModified
				? `Blocked by the authorization gate after resume: the modified prepared value requires a new explicit approval. ${current.reason}`
				: `Blocked by the authorization gate after resume: this recovered call requires operator review. ${current.reason}`
		} else if (!current && reviewed && reviewed.authorization === undefined) {
			reason =
				'The durable review predates bound authorization metadata; review this call again before execution.'
		}

		if (reason) {
			denials.set(call.id, reason)
			await recorder.recordAudit({
				what: { action: 'tool_call', tool: call.name },
				outcome: 'refused',
				reason,
			})
		}
	}

	recorder.pushMessage(plan.assistant)
	const batch = await executor.executeBatch(plan.response, denials, prior, preparedBatch)
	for (const msg of batch.messages) {
		recorder.pushMessage(msg)
	}
}

function modifiedCallIds(decision: HITLResumeDecision): ReadonlySet<string> {
	if (decision.action !== 'modify_tools') return new Set()
	return new Set(
		decision.modifications
			.filter((modification) => modification.action === 'modify')
			.map((modification) => modification.toolCallId),
	)
}

/**
 * Recover completed results and close interrupted calls with unknown outcomes.
 * Only a complete execution scan can authorize the absence of a start record.
 * Unreadable, partial or contradictory evidence never becomes permission to
 * replay; an explicitly answered durable question may re-enter its own tool.
 */
export async function recoverCompletedCalls(
	recorder: TurnRecorder,
	toolCalls: readonly ToolCall[],
	log: Logger,
	options: { answers?: PendingAnswers; signal?: AbortSignal } = {},
): Promise<Map<string, { result: string; isError: boolean }>> {
	const recovered = new Map<string, { result: string; isError: boolean }>()
	let snapshot: ToolExecutionSnapshot | undefined
	try {
		await recorder.flush()
		snapshot = await readToolExecutions(
			recorder.log,
			recorder.turnId,
			toolCalls.map((call) => call.id),
			options.signal,
		)
	} catch (error) {
		if (options.signal?.aborted) throw error
		log.warn('Could not read the transcript to recover completed tool calls', {
			'exception.message': error instanceof Error ? error.message : String(error),
		})
	}
	for (const call of toolCalls) {
		const record = snapshot?.records.get(call.id)
		if (
			snapshot?.complete &&
			(!record || (record.toolName === call.function.name && record.toolUseId === call.id))
		) {
			if (!record) continue // Complete evidence proves this call has no recorded start.
			if (record.status === 'completed') {
				recovered.set(call.id, { result: record.result, isError: record.isError })
				continue
			}
		}
		// The validated checkpoint and explicit answer own this re-entry even
		// when the prior event store is unavailable. No sibling inherits it.
		if ([...(options.answers?.entries() ?? [])].some(([id]) => isPauseForCall(id, call.id)))
			continue
		recovered.set(call.id, {
			result: `Tool execution was interrupted and no trustworthy completion is available for \`${call.function.name}\`. Its outcome is unknown. This resume did not execute it again. Verify external state before deciding whether another call is needed; do not replay a state-changing action to recover its output.`,
			isError: true,
		})
	}

	if (recovered.size > 0) {
		log.info('Restored recorded or unknown tool outcomes without re-executing', {
			'namzu.runtime.recovered': recovered.size,
			'namzu.runtime.of_calls': toolCalls.length,
		})
	}
	return recovered
}

/**
 * Turn a decision into per-call refusals, or `null` when the decision does
 * not resolve the park at all.
 *
 * An empty map means "execute everything" — the shape `executeBatch`
 * already expects for an unrestricted batch.
 */
function derriveDenials(
	toolCalls: readonly ToolCall[],
	decision: HITLResumeDecision,
): ToolCallDenials | null {
	switch (decision.action) {
		case 'approve_tools':
			return new Map()

		case 'reject_tools': {
			const reason = decision.feedback || 'The user rejected this tool call.'
			return new Map(toolCalls.map((tc) => [tc.id, reason]))
		}

		case 'modify_tools': {
			// Mirrors the in-process `modify_tools` branch so a decision
			// means the same thing whether it is answered live or across a
			// restart: named denials refuse, `modify` rewrites the arguments
			// in place, anything unnamed is approved.
			const denials = new Map<string, string>()
			for (const mod of decision.modifications) {
				if (mod.action === 'deny') {
					denials.set(mod.toolCallId, 'The user denied this tool call.')
				}
			}
			for (const mod of decision.modifications) {
				if (mod.action === 'modify' && mod.modifiedInput !== undefined) {
					const tc = toolCalls.find((t) => t.id === mod.toolCallId)
					if (tc && !denials.has(tc.id)) {
						tc.function.arguments = JSON.stringify(mod.modifiedInput)
					}
				}
			}
			return denials
		}

		default:
			// `abort`, `continue`, `answer_question`, … do not describe what
			// to do with a batch of pending tool calls. The caller falls back
			// to the repair path rather than guessing.
			return null
	}
}

/**
 * `executeBatch` consumes a provider response; on resume the response is
 * long gone and the checkpointed assistant turn is the surviving record of
 * it. Usage is zeroed rather than re-invented — those tokens were already
 * billed to the run that produced the turn, and the checkpoint restored
 * that total.
 */
function synthesizeResponse(assistant: AssistantMessage): ChatCompletionResponse {
	return {
		id: `resume_${assistant.toolCalls?.[0]?.id ?? 'pending'}`,
		model: 'resumed-from-checkpoint',
		message: {
			role: 'assistant',
			content: assistant.content,
			toolCalls: assistant.toolCalls,
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

/**
 * All calls owned by the last incomplete batch. Applying a resume plan
 * reconstructs that entire batch, including any partial results already in
 * the checkpoint. Those answered siblings must also be recovered, or their
 * missing prior-result entries would let the executor repeat them.
 */
export function interruptedToolCalls(messages: readonly Message[]): ToolCall[] {
	return lastUnansweredBatch(messages)?.assistant.toolCalls ?? []
}

function lastUnansweredBatch(
	messages: readonly Message[],
): { readonly assistant: AssistantMessage; readonly unanswered: ToolCall[] } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg?.role !== 'assistant') continue
		const assistant = msg as AssistantMessage
		const calls = assistant.toolCalls
		if (!calls || calls.length === 0) continue

		// Only the contiguous result run immediately after this assistant owns
		// its calls. A future/displaced result cannot prove the call completed;
		// treating it as one would skip both crash recovery and the conservative
		// synthetic outcome that prevents a blind side-effect retry.
		const answered = new Set<string>()
		for (let resultIndex = i + 1; resultIndex < messages.length; resultIndex++) {
			const result = messages[resultIndex]
			if (result?.role !== 'tool') break
			answered.add(result.toolCallId)
		}
		const unanswered = calls.filter((call) => !answered.has(call.id))
		if (unanswered.length > 0) return { assistant, unanswered }
		return null
	}
	return null
}
