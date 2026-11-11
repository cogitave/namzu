import type { RunAgentInput } from '@ag-ui/core'
import { MessageSchema, RunAgentInputSchema } from '@ag-ui/core/schemas'
import { AGUIRequestError } from './errors.js'
import { positiveLimit } from './ui.js'

/**
 * How many elements of each collection a request may carry. The validation
 * library builds one issue object per failing element, so the memory a
 * rejected request costs grows with its element count, not its byte count: a
 * 4 MiB body of `1,1,1,...` has about 2 million elements. Every element below
 * is at least about 30 bytes on the wire (`{"id":"a","role":"user","content":"x"}`
 * is 38), so the byte cap alone admits 100,000 or more of them; the defaults
 * sit far above anything a real conversation, tool list or context holds and
 * far below that.
 */
export interface AGUIRequestLimits {
	/** Messages in `messages`. Default 20,000. */
	readonly maxMessages?: number
	/** Content parts in one message. Default 1,000. */
	readonly maxPartsPerMessage?: number
	/** Tool calls on one assistant message. Default 1,000. */
	readonly maxToolCallsPerMessage?: number
	/** Tools in `tools`. Default 2,000. */
	readonly maxTools?: number
	/** Entries in `context`. Default 1,000. */
	readonly maxContextEntries?: number
	/** Entries in `resume`. Default 1,000. */
	readonly maxResumeEntries?: number
}

export const DEFAULT_REQUEST_LIMITS = {
	maxMessages: 20_000,
	maxPartsPerMessage: 1_000,
	maxToolCallsPerMessage: 1_000,
	maxTools: 2_000,
	maxContextEntries: 1_000,
	maxResumeEntries: 1_000,
} as const

export type ResolvedRequestLimits = { readonly [K in keyof AGUIRequestLimits]-?: number }

export function resolveRequestLimits(options: AGUIRequestLimits): ResolvedRequestLimits {
	const resolved = {} as { -readonly [K in keyof ResolvedRequestLimits]: number }
	for (const key of Object.keys(DEFAULT_REQUEST_LIMITS) as (keyof ResolvedRequestLimits)[]) {
		resolved[key] = positiveLimit(options[key], DEFAULT_REQUEST_LIMITS[key], key)
	}
	return resolved
}

/** The public code of a request that carries more elements than a limit allows. */
export const REQUEST_LIMIT_CODE = 'REQUEST_LIMIT_EXCEEDED'

const invalid = () => new AGUIRequestError('Invalid AG-UI RunAgentInput.', 422)

function tooMany(what: string, option: keyof ResolvedRequestLimits, limit: number) {
	return new AGUIRequestError(
		`AG-UI request has more than ${limit} ${what}; raise ${option} to accept it.`,
		422,
		REQUEST_LIMIT_CODE,
	)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Check that every collection the schema validates is within its limit, before
 * any schema runs. It reads lengths only: it builds no issue and copies nothing.
 */
function checkCounts(value: Record<string, unknown>, limits: ResolvedRequestLimits): void {
	const { messages, tools, context, resume } = value
	if (Array.isArray(tools) && tools.length > limits.maxTools)
		throw tooMany('tools', 'maxTools', limits.maxTools)
	if (Array.isArray(context) && context.length > limits.maxContextEntries)
		throw tooMany('context entries', 'maxContextEntries', limits.maxContextEntries)
	if (Array.isArray(resume) && resume.length > limits.maxResumeEntries)
		throw tooMany('resume entries', 'maxResumeEntries', limits.maxResumeEntries)
	if (!Array.isArray(messages)) return
	if (messages.length > limits.maxMessages)
		throw tooMany('messages', 'maxMessages', limits.maxMessages)
	for (const message of messages) {
		if (!isObject(message)) continue
		if (Array.isArray(message.content) && message.content.length > limits.maxPartsPerMessage)
			throw tooMany('content parts in one message', 'maxPartsPerMessage', limits.maxPartsPerMessage)
		if (
			Array.isArray(message.toolCalls) &&
			message.toolCalls.length > limits.maxToolCallsPerMessage
		)
			throw tooMany(
				'tool calls in one message',
				'maxToolCallsPerMessage',
				limits.maxToolCallsPerMessage,
			)
	}
}

/**
 * Validate a `RunAgentInput` with the protocol's own schemas, bounding what a
 * rejected request can cost.
 *
 * 1. Counts are checked first (above), so no collection a schema walks is
 *    larger than its limit.
 * 2. Messages are validated one at a time and the first failure ends it, so
 *    the issues held at any moment are one message's, whose parts and tool
 *    calls are already bounded.
 * 3. Everything else is validated by `RunAgentInputSchema` with `messages`
 *    emptied, then the validated messages go back in. The result equals what
 *    one `RunAgentInputSchema.parse` of the whole request returns.
 *
 * A failure answers a generic 422 that carries none of the request's data.
 */
export function parseRunInput(value: unknown, limits: ResolvedRequestLimits): RunAgentInput {
	if (isObject(value)) checkCounts(value, limits)
	if (!isObject(value) || !Array.isArray(value.messages)) {
		const whole = RunAgentInputSchema.safeParse(value)
		if (!whole.success) throw invalid()
		return whole.data as RunAgentInput
	}
	const messages = []
	for (const message of value.messages) {
		const parsed = MessageSchema.safeParse(message)
		if (!parsed.success) throw invalid()
		messages.push(parsed.data)
	}
	const rest = parseWithoutMessages(value)
	if (!rest.success) throw invalid()
	// The parse result is a fresh object, so the messages go back in place.
	const data = rest.data as RunAgentInput
	data.messages = messages
	return data
}

/**
 * `RunAgentInputSchema` over `value` with `messages` swapped for an empty list,
 * so the messages are not validated twice. When `messages` is a plain writable
 * data property (every parsed JSON body) it is swapped on the caller's own
 * object and restored in `finally`, which copies no key; the whole call is
 * synchronous, so nothing else observes the swap. Anything else (a frozen
 * object, an accessor) is validated through a shallow copy instead.
 */
function parseWithoutMessages(value: Record<string, unknown>) {
	const own = Object.getOwnPropertyDescriptor(value, 'messages')
	if (own && 'value' in own && own.writable === true && !Object.isFrozen(value)) {
		const original = own.value
		value.messages = []
		try {
			return RunAgentInputSchema.safeParse(value)
		} finally {
			value.messages = original
		}
	}
	return RunAgentInputSchema.safeParse({ ...value, messages: [] })
}
