export interface CompactedToolMetadata {
	toolName?: string
	isError?: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

/** A copy keeps its own source/time; this only identifies an unambiguous local tool pair. */
export function compactedToolMetadata(messages: readonly unknown[]): CompactedToolMetadata[] {
	const calls = new Map<string, { index: number; name?: string; count: number }>()
	const results = new Map<string, number>()
	for (const [index, value] of messages.entries()) {
		const message = record(value)
		if (message?.role === 'tool' && typeof message.toolCallId === 'string')
			results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1)
		if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue
		for (const value of message.toolCalls) {
			const call = record(value)
			if (typeof call?.id !== 'string' || !call.id || call.id.length > 1024) continue
			const name = call.type === 'function' ? record(call.function)?.name : undefined
			calls.set(call.id, {
				index,
				name: typeof name === 'string' && name.length > 0 && name.length <= 1024 ? name : undefined,
				count: (calls.get(call.id)?.count ?? 0) + 1,
			})
		}
	}
	let ownerIndex = -1
	return messages.map((value, index) => {
		const message = record(value)
		if (message?.role !== 'tool') {
			ownerIndex = index
			return {}
		}
		const id = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
		const call = id === undefined ? undefined : calls.get(id)
		return {
			...(id !== undefined &&
			call?.count === 1 &&
			call.index === ownerIndex &&
			results.get(id) === 1 &&
			call.name
				? { toolName: call.name }
				: {}),
			...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
		}
	})
}
