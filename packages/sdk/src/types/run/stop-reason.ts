export type StopReason =
	| 'end_turn'
	| 'token_budget'
	| 'cost_limit'
	| 'timeout'
	| 'max_iterations'
	| 'cancelled'
	| 'plan_rejected'
	/** A caller-supplied `stopWhen` predicate returned true. */
	| 'stop_condition'
	/** The model never produced a valid structured output within its retries. */
	| 'structured_output_failed'
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
