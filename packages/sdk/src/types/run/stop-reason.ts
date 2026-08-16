export type StopReason =
	| 'end_turn'
	| 'token_budget'
	| 'cost_limit'
	/**
	 * A `costLimitUsd` was set and part of the run ran at a rate nobody has, so
	 * the limit could not be measured.
	 *
	 * Distinct from `cost_limit`, and the distinction is the reason this value
	 * exists: nothing was overspent. Reporting `cost_limit` would send the
	 * reader to look at spend that was never computed, and would hide the one
	 * fact they need — that the budget they configured was unenforceable for
	 * part of this run.
	 *
	 * `query()` refuses the same combination up front, so this is the case
	 * preflight cannot see: a step naming its own model, or a chain member
	 * declaring one, arriving at a model the price catalogue has no row for.
	 * `costInfo.unpricedTokens` says how much of the run it covers.
	 *
	 * ## The closing call is outside the budget, deliberately
	 *
	 * Every hard stop is followed by one more model call — `requestFinalResponse`
	 * asks for a closing summary, and the guard does not run again before or
	 * after it. That is pre-existing and true of `cost_limit` and
	 * `token_budget` alike, and it is stated here rather than left to be
	 * discovered because for THIS reason it cannot be otherwise: the model that
	 * triggered the stop is by definition one with no rate, so the closing
	 * call's cost is unmeasurable by construction. Bounding it would mean
	 * refusing to close the run at all, which loses the work.
	 *
	 * Its tokens are counted, so `costInfo.unpricedTokens` includes them and
	 * the run reports honestly what it could not price.
	 */
	| 'cost_unmeasurable'
	| 'timeout'
	| 'max_iterations'
	| 'cancelled'
	| 'plan_rejected'
	/** A caller-supplied `stopWhen` predicate returned true. */
	| 'stop_condition'
	/**
	 * A host's `beforeStep` refused the next model call.
	 *
	 * Distinct from `stop_condition`, which reads `steps` and therefore
	 * only fires AFTER the step it disliked ran and was paid for. This one
	 * fires before the provider is called at all — the case a host with a
	 * live rate limit, a revoked tenant or a spend ceiling actually has.
	 */
	| 'step_refused'
	/** The model never produced a valid structured output within its retries. */
	| 'structured_output_failed'
	/**
	 * A host reviewer kept rejecting the answer and the run ran out of
	 * attempts.
	 *
	 * Distinct from a budget stop on purpose: without it the run would end
	 * on `max_iterations` or a token cap, naming the resource it exhausted
	 * rather than the judgement that exhausted it — and the reader would go
	 * looking for a loop instead of at the reviewer.
	 */
	| 'answer_rejected'
	/** An input guardrail refused the run before it started. */
	| 'input_guardrail'
	/** An output guardrail refused the produced result. */
	| 'output_guardrail'
	| 'paused'
	| 'error'

/**
 * Per-LLM-message stop reason — distinct from the run-level {@link StopReason}.
 *
 * The union of the finish reasons providers report, normalised into a
 * provider-agnostic vocabulary. `forced_finalize` is a Namzu-specific value
 * emitted by the orchestrator when iteration limits force a final response
 * without a model-issued stop reason.
 */
export type MessageStopReason =
	| 'end_turn'
	| 'tool_use'
	| 'max_tokens'
	| 'stop_sequence'
	| 'pause_turn'
	| 'refusal'
	| 'forced_finalize'
	/**
	 * The turn was cancelled mid-stream.
	 *
	 * Also Namzu-specific, and added because the cancel path had no way to
	 * close the message it had opened: it re-threw from inside the chunk
	 * loop, so the terminal event never fired and a host consuming the
	 * message lifecycle saw a message begin and never end. A turn that
	 * stops is still a turn that finished streaming, whatever stopped it.
	 */
	| 'cancelled'
