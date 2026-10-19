/**
 * Synthetic user prompt injected by the iteration loop when a turn
 * ends with `stop_reason: max_tokens` AND no tool_use. A turn cut off
 * at the output ceiling is not a finished answer: the loop pushes this
 * message back into the conversation and fires another iteration,
 * letting the model pick up where it was cut off.
 *
 * The exact string is the marker used by `resolveResult` (in
 * `manager/run/persistence.ts`) to detect auto-continuation
 * boundaries: when walking the message tail it skips user messages
 * that match this constant verbatim, so the turn's `result` field
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

/**
 * The nudge for a reply cut off while the model was still reasoning, before
 * it wrote any text or called a tool. There is no partial answer to pick up,
 * so this one asks for a shorter think instead of a continuation. Like
 * {@link AUTO_CONTINUATION_USER_MESSAGE}, it is transparent when a turn's
 * result is assembled.
 */
export const REASONING_CUT_USER_MESSAGE =
	'The output limit was reached while you were still reasoning, before any text or tool call. Continue from the conversation above: think much more briefly and give your answer or next tool call well within the limit.'
