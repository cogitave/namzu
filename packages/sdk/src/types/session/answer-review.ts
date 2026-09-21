import type { SessionId, TurnId } from '../ids/index.js'
import type { Message, UserMessage } from '../message/index.js'
import type { PreparationTextRequest, PreparationTextResult } from './prepare-step.js'

/**
 * A host's verdict on the answer a turn is about to settle with.
 *
 * The halt predicate is only consulted after tools have run, so there was
 * no seam at the point the model stops calling them: the turn finalized
 * with whatever it had produced. Verify-then-fix — run the build, feed the
 * failure back, let it try again — meant starting a whole new turn and
 * re-supplying the context the first one had already assembled.
 */
export type AnswerReview =
	| { readonly accept: true }
	| {
			readonly accept: false
			/**
			 * Feedback supplied as runtime context on the next model request.
			 *
			 * Prose rather than a code, because the model is the audience
			 * and a code would have to be explained to it anyway. Say what
			 * is wrong and what would satisfy the check — "the build fails
			 * with X" gets a fix; "rejected" gets a paraphrase.
			 */
			readonly feedback: string
	  }

/** What the reviewer is told about the turn it is judging. */
export interface AnswerReviewContext {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly iteration: number
	/** Turn cancellation; reviewers should forward it to verification operations. */
	readonly signal?: AbortSignal
	/** Canonical history currently retained by the turn; compaction may remove messages. */
	readonly messages: readonly Message[]
	/**
	 * Isolated copy of the SDK messages dispatched for this candidate's model
	 * request, after context projection and any image-recovery retry. Includes
	 * request-only evidence absent from durable history; excludes this candidate
	 * and subsequently delivered messages/results. This is the provider-chain
	 * input, not a vendor-wire capture or proof of truth/freshness. Optional for
	 * hosts constructing their own review context. Not checkpointed or retained
	 * as conversation history; modifying the copy cannot edit the turn/request.
	 */
	readonly requestMessages?: readonly Message[]
	/**
	 * Isolated copy of the latest operator, goal-round or steering input accepted
	 * before this candidate's dispatch. Retained even when compaction removes
	 * that input from history. Excludes arrivals delivered after dispatch and
	 * runtime reports. This is one input, not the complete task specification
	 * or a guarantee that the original message was sent verbatim to the model.
	 */
	readonly latestUserMessage?: UserMessage
	/**
	 * Optional turn-owned, tool-free inference: at most one call per review
	 * invocation, revoked when the callback ends. Uses the same bounded text
	 * request/result shapes as prepareStep and the turn's metered provider chain,
	 * selected step model and effort. No history, candidate or tools are attached
	 * implicitly. Await its result before returning a verdict; generated text
	 * is a model judgment, not authenticated evidence. Missing in custom hosts
	 * which do not supply this capability.
	 */
	readonly generateText?: (request: PreparationTextRequest) => Promise<PreparationTextResult>
}

/**
 * Judge a completed answer and either accept it or hand it back.
 *
 * Called only when the model stopped calling tools and the turn is about to
 * settle, and never on the forced-final turn — that one exists to extract
 * a closing summary under pressure, and rejecting it would spend budget
 * the turn has already run out of.
 *
 * Exceptions and malformed verdicts fail the turn. Cancellation stops waiting;
 * work started by a reviewer must still honor the supplied signal.
 * Bounded: see the turn's answer-review limit. A reviewer that never
 * accepts stops the turn with a stop reason that names it, rather than
 * looping until the token budget ends the turn for an unrelated reason.
 */
export type ReviewAnswer = (
	answer: string,
	context: AnswerReviewContext,
) => AnswerReview | Promise<AnswerReview>
