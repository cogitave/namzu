/**
 * The one denial string the deny plane speaks.
 *
 * Two places answer a denied call — `runToolReview` (before a human is asked)
 * and `ToolExecutor` (before dispatch, after every rewrite). The model must not
 * be able to tell them apart: a denial that reads differently depending on which
 * check caught it teaches the model which path to take to get a different
 * answer. One formatter, one wording.
 */
export function gateDenialOutput(toolName: string, reason: string): string {
	return `Error: Tool call "${toolName}" blocked by verification gate: ${reason}`
}
