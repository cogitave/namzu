import type { SpillRef } from './spill.js'

/**
 * A tool call's input can be larger than a session-log record may be (a
 * write of a few megabytes, a batch of large writes). The record that carries
 * it then holds this stand-in, and the input itself sits in `tool-results/`
 * under the same rules as any other spilled body.
 */
export const SPILLED_INPUT_KEY = '$spilledInput'

/** Characters of the input kept inline beside the reference. */
const INPUT_PREVIEW_CHARS = 200

export interface SpilledInput {
	readonly [SPILLED_INPUT_KEY]: SpillRef
	readonly preview: string
}

export function spilledInput(ref: SpillRef, json: string): SpilledInput {
	return { [SPILLED_INPUT_KEY]: ref, preview: json.slice(0, INPUT_PREVIEW_CHARS) }
}

export function isSpilledInput(value: unknown): value is SpilledInput {
	return (
		typeof value === 'object' &&
		value !== null &&
		SPILLED_INPUT_KEY in value &&
		typeof (value as Record<string, unknown>)[SPILLED_INPUT_KEY] === 'object'
	)
}

/** Where a record keeps tool inputs: the holder object and the key of the input in it. */
export interface InputSlot {
	readonly holder: Record<string, unknown>
	readonly key: string
}

function callSlots(calls: unknown): InputSlot[] {
	if (!Array.isArray(calls)) return []
	const slots: InputSlot[] = []
	for (const call of calls) {
		if (typeof call === 'object' && call !== null && 'input' in call) {
			slots.push({ holder: call as Record<string, unknown>, key: 'input' })
		}
	}
	return slots
}

/** Record types that carry a tool call's whole input. */
export const TOOL_INPUT_RECORD_TYPES: ReadonlySet<string> = new Set([
	'tool_review_requested',
	'decision_requested',
	'tool_executing',
	'tool_input_completed',
])

/**
 * The input slots of one record. The record is read, never changed; the
 * caller copies what it replaces.
 */
export function toolInputSlots(record: Record<string, unknown>): InputSlot[] {
	switch (record.type) {
		case 'tool_review_requested':
			return callSlots(record.toolCalls)
		case 'decision_requested': {
			const request = record.request as { toolCalls?: unknown } | undefined
			return request ? callSlots(request.toolCalls) : []
		}
		case 'tool_executing':
		case 'tool_input_completed':
			return 'input' in record ? [{ holder: record, key: 'input' }] : []
		default:
			return []
	}
}

/**
 * The input slots of a request read back from a log, with any stand-in
 * replaced by the input it stands for. Mutates and returns `request`.
 */
export async function restoreSpilledRequestInputs<T extends { toolCalls?: unknown }>(
	request: T,
	read: (ref: SpillRef) => Promise<string>,
): Promise<T> {
	for (const { holder, key } of callSlots(request.toolCalls)) {
		const value = holder[key]
		if (isSpilledInput(value)) holder[key] = JSON.parse(await read(value[SPILLED_INPUT_KEY]))
	}
	return request
}
