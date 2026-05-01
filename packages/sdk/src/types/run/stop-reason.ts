export type StopReason =
	| 'end_turn'
	| 'token_budget'
	| 'cost_limit'
	| 'timeout'
	| 'max_iterations'
	| 'cancelled'
	| 'plan_rejected'
	| 'paused'
	| 'error'

/**
 * Per-LLM-message stop reason — distinct from the run-level {@link StopReason}.
 *
 * Mirrors the union of Anthropic and OpenAI finish reasons normalised into a
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
