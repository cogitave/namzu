/**
 * The attribute bags, re-exported from the SDK rather than restated here.
 *
 * This file used to be a hand-maintained copy, and it had already drifted:
 * it was missing `GENAI.TOKEN_TYPE`, the dimension that splits the token
 * counter by kind. Nothing caught it — this package had no tests, and the
 * public-surface verifier only loads the SDK bundle.
 *
 * The consequence was narrow (namzu emits through the canonical module, so
 * the dimension is on the data regardless, and the constant is reachable
 * from the SDK root barrel) but the shape of the defect is not: a second
 * copy of a constant bag drifts by default, and this is the entry point the
 * observability docs steer consumers to. `@namzu/sdk` is already a peer
 * dependency, so a re-export costs nothing and cannot fall behind.
 *
 * The span-name helpers below are NOT re-exports — the SDK publishes none
 * of them, so this subpath is their only home.
 */
export { GENAI, NAMZU } from '@namzu/sdk'

export function agentRunSpanName(agentName: string): string {
	return `namzu.agent.run ${agentName}`
}

export function agentIterationSpanName(iteration: number): string {
	return `namzu.agent.iteration ${iteration}`
}

export function chatSpanName(model: string): string {
	return `chat ${model}`
}

export function toolSpanName(toolName: string): string {
	return `namzu.tool.execute ${toolName}`
}
