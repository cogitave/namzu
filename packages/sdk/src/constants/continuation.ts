/**
 * Synthetic user prompt injected by the iteration loop when a turn
 * ends with `stop_reason: max_tokens` AND no tool_use. Mirrors
 * Claude.ai's "Continue" affordance: the loop pushes this message
 * back into the conversation and fires another iteration, letting
 * the model pick up where it was cut off.
 *
 * The exact string is the marker used by `resolveResult` (in
 * `manager/run/persistence.ts`) to detect auto-continuation
 * boundaries: when walking the message tail it skips user messages
 * that match this constant verbatim, so the run's `result` field
 * concatenates the full multi-turn assistant output instead of only
 * surfacing the trailing continuation chunk.
 *
 * Lives in `constants/` (not `runtime/query/`) because both the
 * runtime iteration loop and `manager/run/persistence.ts` consume
 * it — a manager→runtime import for a string constant would create
 * a manager↔runtime directory cycle.
 */
export const AUTO_CONTINUATION_USER_MESSAGE =
	'Continue exactly where you left off. Do not repeat content you already wrote — pick up at the next token.'
