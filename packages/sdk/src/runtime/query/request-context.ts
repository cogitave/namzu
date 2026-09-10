import { createHash } from 'node:crypto'
import type { Message, MessageRole } from '../../types/message/index.js'

/** A content block present at the SDK's provider-input boundary, not a file freshness claim. */
export interface RequestContextPart {
	readonly messageIndex: number
	readonly partIndex: number
	readonly role: MessageRole
	readonly kind: 'text' | 'image' | 'document' | 'stored' | 'tool-call'
	readonly digest: string
	readonly toolCallId?: string
	readonly isError?: boolean
}

export interface RequestContextSnapshot {
	readonly boundary: 'provider-input'
	readonly parts: readonly RequestContextPart[]
}

export interface RequestContextChange {
	/** Parts from the earlier snapshot no longer present, including replaced content. */
	readonly removed: readonly RequestContextPart[]
	/** Parts in the new snapshot not present before. */
	readonly added: readonly RequestContextPart[]
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return item
		return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
	})
}

/**
 * Inspect supplied messages after compaction and request projection. No content
 * is retained in the snapshot. A digest identifies exact blocks, not semantic
 * knowledge, token counts, file versions or provider-private reasoning replay.
 */
export function snapshotRequestContext(messages: readonly Message[]): RequestContextSnapshot {
	const parts: RequestContextPart[] = []
	for (const [messageIndex, message] of messages.entries()) {
		let partIndex = 0
		const add = (kind: RequestContextPart['kind'], payload: unknown, toolCallId?: string) => {
			parts.push(
				Object.freeze({
					messageIndex,
					partIndex: partIndex++,
					role: message.role,
					kind,
					digest: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
					...(toolCallId !== undefined ? { toolCallId } : {}),
					...(message.role === 'tool' ? { isError: message.isError === true } : {}),
				}),
			)
		}
		const callId = message.role === 'tool' ? message.toolCallId : undefined
		if (typeof message.content === 'string') add('text', message.content, callId)
		else if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === 'text') add('text', block.text, callId)
				else add(block.type, block, callId)
			}
		}
		if (message.role === 'user') {
			for (const attachment of message.attachments ?? []) {
				add(attachment.type ?? 'image', attachment)
			}
		}
		if (message.role === 'assistant') {
			for (const call of message.toolCalls ?? []) {
				add('tool-call', [call.function.name, call.function.arguments], call.id)
			}
		}
	}
	return Object.freeze({ boundary: 'provider-input', parts: Object.freeze(parts) })
}

const key = (part: RequestContextPart): string =>
	JSON.stringify([part.role, part.kind, part.toolCallId, part.isError, part.digest])

/** Compare occurrences, not sets: removing one of two identical blocks is a removal. */
export function diffRequestContext(
	previous: RequestContextSnapshot,
	next: RequestContextSnapshot,
): RequestContextChange {
	const unmatched = new Map<string, RequestContextPart[]>()
	for (const part of previous.parts) {
		const identity = key(part)
		const occurrences = unmatched.get(identity) ?? []
		occurrences.push(part)
		unmatched.set(identity, occurrences)
	}
	const added: RequestContextPart[] = []
	for (const part of next.parts) {
		const occurrences = unmatched.get(key(part))
		if (occurrences?.length) occurrences.pop()
		else added.push(part)
	}
	const removed = [...unmatched.values()]
		.flat()
		.sort((a, b) => a.messageIndex - b.messageIndex || a.partIndex - b.partIndex)
	return Object.freeze({ removed: Object.freeze(removed), added: Object.freeze(added) })
}
