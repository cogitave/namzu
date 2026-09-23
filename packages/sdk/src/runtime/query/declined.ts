/**
 * What the model is told when a person declines its tool calls and gave no
 * words of their own.
 *
 * "Declined" alone reads to a model as an obstacle to route around: in a live
 * session an operator refused a browser navigation and the model fetched the
 * same page through web search instead. The refusal is about the outcome, not
 * the tool, so the text says so — for every tool, since any of them can be
 * swapped for another that reaches the same place.
 */
export const DECLINED_TOOL_CALL_FEEDBACK =
	'The user declined this. Do not get the same content or result another way (another tool, another site or address, or a web search) unless you ask the user first and they agree. Say what you wanted to do, or carry on without it.'
