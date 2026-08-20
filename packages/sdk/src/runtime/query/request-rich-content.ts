import type { Message, MessageAttachment, ToolResultBlock } from '../../types/message/index.js'

/**
 * Maximum accumulated inline rich-content payload sent on one model request.
 *
 * Base64 is ASCII, so its JavaScript string length is also its encoded wire
 * payload length before the surrounding JSON. The bound deliberately counts
 * the encoded value rather than estimating decoded bytes: request gateways
 * reject the body they receive, not the file the body represents.
 */
export const DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES = 24 * 1024 * 1024

const MAX_REQUEST_RICH_CONTENT_BYTES = Number.MAX_SAFE_INTEGER

export function resolveMaxRequestRichContentBytes(value: number | undefined): number {
	const resolved = value ?? DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES
	if (
		!Number.isSafeInteger(resolved) ||
		resolved < 0 ||
		resolved > MAX_REQUEST_RICH_CONTENT_BYTES
	) {
		throw new RangeError(
			`maxRequestRichContentBytes must be a safe integer from 0 to ${MAX_REQUEST_RICH_CONTENT_BYTES}; received ${String(resolved)}`,
		)
	}
	return resolved
}

type RichKind = 'image' | 'document'

interface RichOccurrence {
	readonly messageIndex: number
	readonly itemIndex: number
	readonly source: 'user' | 'tool'
	readonly kind: RichKind
	readonly bytes: number
}

const userMarker = (kind: RichKind): string =>
	`[${kind} omitted from this model request to keep the accumulated rich-content payload within its configured size limit; attach it again in a new message if it is still needed.]`

const toolMarker = (kind: RichKind): string =>
	`[${kind} omitted from this model request to keep the accumulated rich-content payload within its configured size limit; call the producing tool again if it is still needed.]`

function assertInlineAttachment(
	attachment: MessageAttachment,
): asserts attachment is Exclude<MessageAttachment, { readonly type: 'stored' }> {
	if (attachment.type === 'stored') {
		throw new TypeError(
			'Cannot budget an unresolved stored attachment; resolve attachment bytes before building a model request',
		)
	}
}

function collectRichOccurrences(messages: readonly Message[]): RichOccurrence[] {
	const occurrences: RichOccurrence[] = []

	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === 'user') {
			for (const [itemIndex, attachment] of (message.attachments ?? []).entries()) {
				assertInlineAttachment(attachment)
				occurrences.push({
					messageIndex,
					itemIndex,
					source: 'user',
					kind: attachment.type === 'document' ? 'document' : 'image',
					bytes: attachment.data.length,
				})
			}
			continue
		}

		if (message.role !== 'tool' || !Array.isArray(message.content)) continue
		for (const [itemIndex, block] of message.content.entries()) {
			if (block.type !== 'image' && block.type !== 'document') continue
			occurrences.push({
				messageIndex,
				itemIndex,
				source: 'tool',
				kind: block.type,
				bytes: block.data.length,
			})
		}
	}

	return occurrences
}

function appendMarkers(content: string, kinds: readonly RichKind[]): string {
	if (kinds.length === 0) return content
	const markers = kinds.map(userMarker).join('\n\n')
	return content.length > 0 ? `${content}\n\n${markers}` : markers
}

/**
 * Build the provider-bound view of a conversation without editing history.
 *
 * User attachments and rich tool-result blocks share one oldest-first budget.
 * Tool messages and their `toolCallId` are never removed, so the projected
 * transcript retains its provider-valid call/result structure. Returning the
 * original array when nothing is omitted makes the no-op and exact-boundary
 * cases observable and keeps the common path allocation-free.
 */
export function projectRequestRichContent(messages: Message[], maxBytes: number): Message[] {
	const occurrences = collectRichOccurrences(messages)
	if (maxBytes === 0 || occurrences.length === 0) return messages

	let total = occurrences.reduce((sum, occurrence) => sum + occurrence.bytes, 0)
	if (total <= maxBytes) return messages

	const omitted = new Map<number, Map<number, RichOccurrence>>()
	for (const occurrence of occurrences) {
		if (total <= maxBytes) break
		total -= occurrence.bytes
		let byItem = omitted.get(occurrence.messageIndex)
		if (!byItem) {
			byItem = new Map()
			omitted.set(occurrence.messageIndex, byItem)
		}
		byItem.set(occurrence.itemIndex, occurrence)
	}

	return messages.map((message, messageIndex) => {
		const byItem = omitted.get(messageIndex)
		if (!byItem) return message

		if (message.role === 'user') {
			const { attachments = [], ...withoutAttachments } = message
			const kept = attachments.filter((_attachment, itemIndex) => !byItem.has(itemIndex))
			const omittedKinds = [...byItem.values()]
				.filter((occurrence) => occurrence.source === 'user')
				.sort((a, b) => a.itemIndex - b.itemIndex)
				.map((occurrence) => occurrence.kind)
			return {
				...withoutAttachments,
				content: appendMarkers(message.content, omittedKinds),
				...(kept.length > 0 ? { attachments: kept } : {}),
			}
		}

		if (message.role === 'tool' && Array.isArray(message.content)) {
			const content: ToolResultBlock[] = message.content.map((block, itemIndex) => {
				const occurrence = byItem.get(itemIndex)
				return occurrence?.source === 'tool'
					? { type: 'text', text: toolMarker(occurrence.kind) }
					: block
			})
			return { ...message, content }
		}

		return message
	})
}
