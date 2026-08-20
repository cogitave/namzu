import type { RunPersistence } from '../../manager/run/persistence.js'
import type {
	CheckpointId,
	HITLResumeDecision,
	IterationCheckpoint,
} from '../../types/hitl/index.js'
import type { AssistantMessage, Message, ToolCall } from '../../types/message/index.js'
import type { ChatCompletionResponse } from '../../types/provider/index.js'
import type { Logger } from '../../utils/logger.js'
import type { PriorToolResults, ToolCallDenials, ToolExecutor } from './executor.js'
import { PendingAnswers } from './question-park.js'
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
	checkpoint: IterationCheckpoint,
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
		checkpointId: checkpoint.id,
		assistant,
		response: synthesizeResponse(assistant),
		denials,
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
	checkpoint: IterationCheckpoint,
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
 * Decide whether a checkpoint left behind a batch that was PART-WAY
 * through executing when the process died.
 *
 * The ordinary repair for an unanswered assistant turn — strip it and let
 * the model re-decide — is right when nothing ran: the calls were still
 * awaiting a decision, so re-deciding costs only a round trip. It is
 * exactly wrong when some of them already ran, because re-deciding means
 * re-executing, and a tool that charged a card does not become idempotent
 * on the second attempt.
 *
 * The discriminator is the transcript: a tool-review park records the
 * checkpoint BEFORE any execution, so it has no completed calls and takes
 * the cheap path unchanged. One or more completions means execution had
 * begun, which is a resume, not a fresh decision.
 *
 * The calls that did NOT complete are executed here for the first time,
 * through the ordinary executor — so every guard, permission check and
 * probe still applies to them.
 */
export function planCrashResume(
	checkpoint: IterationCheckpoint,
	completed: ReadonlyMap<string, unknown>,
	log: Logger,
): PendingResumePlan | null {
	const assistant = lastUnansweredBatch(checkpoint.messages)?.assistant
	const calls = assistant?.toolCalls
	if (!assistant || !calls || calls.length === 0) return null

	const done = calls.filter((tc) => completed.has(tc.id))
	if (done.length === 0) return null

	log.warn('Checkpoint holds a tool batch that was part-way through executing', {
		'namzu.checkpoint.id': checkpoint.id,
		'namzu.runtime.completed': done.length,
		'namzu.runtime.total': calls.length,
		'namzu.runtime.remaining': calls
			.filter((tc) => !completed.has(tc.id))
			.map((tc) => tc.function.name),
	})

	return {
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
	runMgr: RunPersistence,
	executor: ToolExecutor,
	prior?: PriorToolResults,
): Promise<void> {
	runMgr.pushMessage(plan.assistant)
	const batch = await executor.executeBatch(plan.response, plan.denials, prior)
	for (const msg of batch.messages) {
		runMgr.pushMessage(msg)
	}
}

/**
 * Results the run already produced for calls in `toolCalls`.
 *
 * Read from the transcript, which records a `tool_completed` per tool as
 * it finishes — durable long before the batch settles. Scoped to the calls
 * being resumed so an id from an earlier turn can never answer this one.
 *
 * A failure to read is not fatal: the worst case is the behaviour that
 * existed before this recovery, and refusing to resume because a log could
 * not be read would be a strictly worse trade.
 */
export async function recoverCompletedCalls(
	runMgr: RunPersistence,
	toolCalls: readonly ToolCall[],
	log: Logger,
): Promise<Map<string, { result: string; isError: boolean }>> {
	const recovered = new Map<string, { result: string; isError: boolean }>()
	try {
		const completed = await runMgr.getRunStore().readCompletedTools()
		for (const call of toolCalls) {
			const record = completed.get(call.id)
			if (record) recovered.set(call.id, { result: record.result, isError: record.isError })
		}
	} catch (error) {
		log.warn('Could not read the transcript to recover completed tool calls', {
			'exception.message': error instanceof Error ? error.message : String(error),
		})
		return new Map()
	}

	if (recovered.size > 0) {
		log.info('Recovered tool results from the transcript instead of re-executing', {
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
 * Tool calls in the history that no `tool_result` answers.
 *
 * The set worth asking the transcript about: an already-answered call's
 * result is in the history and needs no recovery.
 */
export function unansweredToolCalls(messages: readonly Message[]): ToolCall[] {
	return lastUnansweredBatch(messages)?.unanswered ?? []
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
