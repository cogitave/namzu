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
	readonly reason: 'budget' | 'provider-rejected'
}

export interface RequestImageIdentity {
	readonly data: string
	readonly mediaType: string
}

const userMarker = (kind: RichKind): string =>
	`[${kind} omitted from this model request to keep the accumulated rich-content payload within its configured size limit; attach it again in a new message if it is still needed.]`

const toolMarker = (kind: RichKind): string =>
	`[${kind} omitted from this model request to keep the accumulated rich-content payload within its configured size limit; call the producing tool again if it is still needed.]`

const rejectedUserImageMarker = (): string =>
	'[image omitted from this model request because the provider rejected this image; attach a corrected image in a new message if it is still needed.]'

const rejectedToolImageMarker = (): string =>
	'[image omitted from this model request because the provider rejected this image; call the producing tool again after correcting its image source if it is still needed.]'

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
					reason:
						attachment.type !== 'document' &&
						attachment.modelOmission?.reason === 'provider-rejected'
							? 'provider-rejected'
							: 'budget',
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
				reason:
					block.type === 'image' && block.modelOmission?.reason === 'provider-rejected'
						? 'provider-rejected'
						: 'budget',
			})
		}
	}

	return occurrences
}

function appendTextMarkers(content: string, markers: readonly string[]): string {
	if (markers.length === 0) return content
	const joined = markers.join('\n\n')
	return content.length > 0 ? `${content}\n\n${joined}` : joined
}

function appendMarkers(content: string, occurrences: readonly RichOccurrence[]): string {
	const markers = occurrences.map((occurrence) =>
		occurrence.reason === 'provider-rejected'
			? rejectedUserImageMarker()
			: userMarker(occurrence.kind),
	)
	return appendTextMarkers(content, markers)
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
	if (occurrences.length === 0) return messages

	const omitted = new Map<number, Map<number, RichOccurrence>>()
	const omit = (occurrence: RichOccurrence): void => {
		let byItem = omitted.get(occurrence.messageIndex)
		if (!byItem) {
			byItem = new Map()
			omitted.set(occurrence.messageIndex, byItem)
		}
		byItem.set(occurrence.itemIndex, occurrence)
	}

	for (const occurrence of occurrences) {
		if (occurrence.reason === 'provider-rejected') omit(occurrence)
	}

	let total = occurrences.reduce(
		(sum, occurrence) => sum + (occurrence.reason === 'budget' ? occurrence.bytes : 0),
		0,
	)
	if (maxBytes > 0 && total > maxBytes) {
		for (const occurrence of occurrences) {
			if (total <= maxBytes) break
			if (occurrence.reason !== 'budget') continue
			total -= occurrence.bytes
			omit(occurrence)
		}
	}
	if (omitted.size === 0) return messages

	return messages.map((message, messageIndex) => {
		const byItem = omitted.get(messageIndex)
		if (!byItem) return message

		if (message.role === 'user') {
			const { attachments = [], ...withoutAttachments } = message
			const kept = attachments.filter((_attachment, itemIndex) => !byItem.has(itemIndex))
			const omittedOccurrences = [...byItem.values()]
				.filter((occurrence) => occurrence.source === 'user')
				.sort((a, b) => a.itemIndex - b.itemIndex)
			return {
				...withoutAttachments,
				content: appendMarkers(message.content, omittedOccurrences),
				...(kept.length > 0 ? { attachments: kept } : {}),
			}
		}

		if (message.role === 'tool' && Array.isArray(message.content)) {
			const content: ToolResultBlock[] = message.content.map((block, itemIndex) => {
				const occurrence = byItem.get(itemIndex)
				return occurrence?.source === 'tool'
					? {
							type: 'text',
							text:
								occurrence.reason === 'provider-rejected'
									? rejectedToolImageMarker()
									: toolMarker(occurrence.kind),
						}
					: block
			})
			return { ...message, content }
		}

		return message
	})
}

function sameImage(
	image: { readonly data: string; readonly mediaType: string },
	identity: RequestImageIdentity,
): boolean {
	return image.data === identity.data && image.mediaType === identity.mediaType
}

/** Find the one distinct image in the exact provider-bound request, if one exists. */
export function findSingleRequestImage(messages: readonly Message[]): RequestImageIdentity | null {
	let candidate: RequestImageIdentity | null = null
	for (const message of messages) {
		if (message.role === 'user') {
			for (const attachment of message.attachments ?? []) {
				if (attachment.type === 'stored') {
					throw new TypeError(
						'Cannot inspect an unresolved stored attachment at the provider boundary',
					)
				}
				if (attachment.type === 'document') continue
				if (candidate === null) {
					candidate = { data: attachment.data, mediaType: attachment.mediaType }
				} else if (!sameImage(attachment, candidate)) {
					return null
				}
			}
			continue
		}
		if (message.role !== 'tool' || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block.type !== 'image') continue
			if (candidate === null) {
				candidate = { data: block.data, mediaType: block.mediaType }
			} else if (!sameImage(block, candidate)) {
				return null
			}
		}
	}
	return candidate
}

/** Build the one-off retry request without changing durable conversation state. */
export function projectRequestWithoutImage(
	messages: Message[],
	identity: RequestImageIdentity,
): Message[] {
	return messages.map((message) => {
		if (message.role === 'user') {
			const attachments = message.attachments ?? []
			const rejected = attachments.filter(
				(attachment) =>
					attachment.type !== 'stored' &&
					attachment.type !== 'document' &&
					sameImage(attachment, identity),
			)
			if (rejected.length === 0) return message
			const kept = attachments.filter(
				(attachment) =>
					attachment.type === 'stored' ||
					attachment.type === 'document' ||
					!sameImage(attachment, identity),
			)
			const { attachments: _attachments, ...withoutAttachments } = message
			return {
				...withoutAttachments,
				content: appendTextMarkers(
					message.content,
					rejected.map(() => rejectedUserImageMarker()),
				),
				...(kept.length > 0 ? { attachments: kept } : {}),
			}
		}
		if (message.role !== 'tool' || !Array.isArray(message.content)) return message
		let changed = false
		const content: ToolResultBlock[] = message.content.map((block) => {
			if (block.type !== 'image' || !sameImage(block, identity)) return block
			changed = true
			return { type: 'text', text: rejectedToolImageMarker() }
		})
		return changed ? { ...message, content } : message
	})
}

/** Persist a successful recovery while retaining exact image bytes. */
export function markProviderRejectedImage(
	messages: readonly Message[],
	identity: RequestImageIdentity,
): { readonly messages: Message[]; readonly count: number } {
	let count = 0
	const marked = messages.map((message) => {
		if (message.role === 'user') {
			let changed = false
			const attachments = message.attachments?.map((attachment) => {
				if (
					attachment.type === 'stored' ||
					attachment.type === 'document' ||
					!sameImage(attachment, identity) ||
					attachment.modelOmission?.reason === 'provider-rejected'
				) {
					return attachment
				}
				changed = true
				count += 1
				return { ...attachment, modelOmission: { reason: 'provider-rejected' as const } }
			})
			return changed ? { ...message, attachments } : message
		}
		if (message.role !== 'tool' || !Array.isArray(message.content)) return message
		let changed = false
		const content: ToolResultBlock[] = message.content.map((block) => {
			if (
				block.type !== 'image' ||
				!sameImage(block, identity) ||
				block.modelOmission?.reason === 'provider-rejected'
			) {
				return block
			}
			changed = true
			count += 1
			return { ...block, modelOmission: { reason: 'provider-rejected' as const } }
		})
		return changed ? { ...message, content } : message
	})
	return { messages: marked, count }
}
