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
export function parentContext(parent?: import('@opentelemetry/api').Span | SerializedSpanContext) {
	const active = otelContext.active()
	if (!parent) return active
	// A live span goes in as itself. Round-tripping it through
	// `wrapSpanContext` would replace a recording span with a non-recording
	// stand-in — same ids, but the parent stops being the object callers
	// hold, and anything reading it back gets a hollow one.
	if (!isSerialized(parent)) return trace.setSpan(active, parent)

	const context = toSpanContext(parent)
	if (!context) return active
	return trace.setSpan(active, trace.wrapSpanContext(context))
}

/**
 * A span context flattened for storage.
 *
 * `parentContext` used to accept only a live in-memory span, so a parent
 * that had to survive a process boundary could not be expressed at all — a
 * run that crashed at iteration 12 and resumed produced two traces with
 * different trace ids and no link between them, and the crash and its
 * recovery could not be put on one timeline. Every span carries
 * `namzu.run.id`, which is enough to FIND both traces by query and not
 * enough to see one waterfall; and that much disappears for a replay fork,
 * which mints a new run id.
 *
 * Flat strings rather than the OTel type so it survives `JSON.stringify`
 * into a checkpoint unchanged.
 */
export interface SerializedSpanContext {
	readonly traceId: string
	readonly spanId: string
	readonly traceFlags: number
	/** Whether the parent lives in a different process. Always true on read. */
	readonly isRemote?: boolean
}

function isSerialized(
	value: import('@opentelemetry/api').Span | SerializedSpanContext,
): value is SerializedSpanContext {
	return typeof (value as SerializedSpanContext).traceId === 'string'
}

const HEX_TRACE_ID = /^[0-9a-f]{32}$/
const HEX_SPAN_ID = /^[0-9a-f]{16}$/

/**
 * Rebuild an OTel span context, or return `undefined` for one that is not
 * usable.
 *
 * Both ids are validated: an exporter given a malformed or all-zero id
 * silently drops the span, so an unchecked value turns "the resume is
 * linked to the crash" into "there is no resume trace at all" — a strictly
 * worse outcome than the disconnected traces this replaces.
 */
function toSpanContext(
	serialized: SerializedSpanContext,
): import('@opentelemetry/api').SpanContext | undefined {
	const { traceId, spanId } = serialized
	if (!HEX_TRACE_ID.test(traceId) || !HEX_SPAN_ID.test(spanId)) return undefined
	if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined
	return {
		traceId,
		spanId,
		traceFlags: serialized.traceFlags,
		// The parent was recorded in another process, whatever that process
		// was; saying otherwise makes a sampler treat it as locally sampled.
		isRemote: true,
	}
}

/** Flatten a live span for storage, or `undefined` when there is nothing real to store. */
export function serializeSpan(
	span?: import('@opentelemetry/api').Span,
): SerializedSpanContext | undefined {
	const context = span?.spanContext()
	if (!context) return undefined
	if (!HEX_TRACE_ID.test(context.traceId) || /^0+$/.test(context.traceId)) return undefined
	return {
		traceId: context.traceId,
		spanId: context.spanId,
		traceFlags: context.traceFlags,
		isRemote: false,
	}
}
