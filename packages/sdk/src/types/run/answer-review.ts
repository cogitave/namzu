import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'

/**
 * A host's verdict on the answer a run is about to settle with.
 *
 * The halt predicate is only consulted after tools have run, so there was
 * no seam at the point the model stops calling them: the run finalized
 * with whatever it had produced. Verify-then-fix — run the build, feed the
 * failure back, let it try again — meant starting a whole new run and
 * re-supplying the context the first one had already assembled.
 */
export type AnswerReview =
	| { readonly accept: true }
	| {
			readonly accept: false
			/**
			 * What to send back, as the user turn the model will read next.
			 *
			 * Prose rather than a code, because the model is the audience
			 * and a code would have to be explained to it anyway. Say what
			 * is wrong and what would satisfy the check — "the build fails
			 * with X" gets a fix; "rejected" gets a paraphrase.
			 */
			readonly feedback: string
	  }

/** What the reviewer is told about the run it is judging. */
export interface AnswerReviewContext {
	readonly runId: RunId
	readonly iteration: number
	/** The full history, so a reviewer can see how the answer was reached. */
	readonly messages: readonly Message[]
}

/**
 * Judge a completed answer and either accept it or hand it back.
 *
 * Called only when the model stopped calling tools and the run is about to
 * settle, and never on the forced-final turn — that one exists to extract
 * a closing summary under pressure, and rejecting it would spend budget
 * the run has already run out of.
 *
 * Bounded: see the run's answer-review limit. A reviewer that never
 * accepts stops the run with a stop reason that names it, rather than
 * looping until the token budget ends the run for an unrelated reason.
 */
export type ReviewAnswer = (
	answer: string,
	context: AnswerReviewContext,
) => AnswerReview | Promise<AnswerReview>
