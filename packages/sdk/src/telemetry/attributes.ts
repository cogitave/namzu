import { context as otelContext, trace } from '@opentelemetry/api'
export { GENAI, NAMZU } from '../constants/telemetry/index.js'

export function agentRunSpanName(agentName: string): string {
	return `namzu.agent.run ${agentName}`
}

export function agentIterationSpanName(iteration: number): string {
	return `namzu.agent.iteration ${iteration}`
}

export function toolSpanName(toolName: string): string {
	return `namzu.tool.execute ${toolName}`
}

/**
 * OTel GenAI semconv names the model-call span `chat {model}`.
 *
 * There was no span around the model call at all — `chatSpanName` existed
 * in `@namzu/telemetry` with zero call sites — so a run's traces carried
 * no LLM latency whatsoever, and the token attributes landed on the
 * iteration span instead of the operation that produced them.
 */
export function chatSpanName(model: string): string {
	return `chat ${model}`
}

/**
 * Build a context that parents a new span to `parent`.
 *
 * Async generators cannot use `startActiveSpan` for parenting: a generator
 * body resumes on its CONSUMER's async context, so whatever was active when
 * the parent span was created is gone by the time the child is made. Every
 * span-owning body in the run loop is a generator, which is why a 20-turn
 * run emitted 21 disconnected root spans. Passing the parent explicitly is
 * the only thing that works here.
 */
export function parentContext(parent?: import('@opentelemetry/api').Span) {
	const active = otelContext.active()
	return parent ? trace.setSpan(active, parent) : active
}
