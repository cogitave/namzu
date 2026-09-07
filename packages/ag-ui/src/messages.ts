import { type Message as AGUIMessage, type InputContent, MessageSchema } from '@ag-ui/core'
import type { Message, MessageAttachment, ToolCall, UserMessage } from '@namzu/sdk'
import { AGUIRequestError } from './errors.js'

export interface AGUIMessageOptions {
	/** Admit trusted system/developer messages; both become Namzu system messages. Default false. */
	readonly allowSystemMessages?: boolean
}

const fail = (message: string): never => {
	throw new AGUIRequestError(
		`Cannot convert AG-UI history: ${message}`,
		422,
		'INVALID_MESSAGE_HISTORY',
	)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasToolErrorMetadata(metadata: unknown): boolean {
	if (!isObject(metadata) || !Object.hasOwn(metadata, 'namzu')) return false
	const namzu = metadata.namzu
	return isObject(namzu) && Object.hasOwn(namzu, 'isError') && namzu.isError === true
}

function inlineAttachment(
	kind: 'image' | 'document',
	data: string,
	mediaType: string,
	name?: string,
): MessageAttachment {
	if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mediaType)) {
		return fail('inline content requires a valid media type')
	}
	if (kind === 'image' && !mediaType.startsWith('image/')) {
		return fail('image content requires an image media type')
	}
	// Buffer.from is deliberately not the validator: it silently accepts malformed base64.
	if (!data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
		return fail('inline content requires non-empty base64 bytes without a data URL prefix')
	}
	return {
		type: kind,
		data,
		mediaType,
		...(kind === 'document' && name !== undefined ? { name } : {}),
	}
}

function attachment(part: Exclude<InputContent, { type: 'text' }>): MessageAttachment {
	switch (part.type) {
		case 'image':
		case 'document':
			if (part.source.type !== 'data') {
				return fail('URL content is unsupported; supply inline base64 data')
			}
			return inlineAttachment(part.type, part.source.value, part.source.mimeType)
		case 'binary': {
			if (part.data === undefined || part.url !== undefined || part.id !== undefined) {
				return fail('binary content requires inline data without URL or ID references')
			}
			const kind = part.mimeType.startsWith('image/')
				? 'image'
				: part.mimeType === 'application/pdf' || part.mimeType === 'text/plain'
					? 'document'
					: undefined
			if (!kind) return fail('unsupported binary media type')
			return inlineAttachment(kind, part.data, part.mimeType, part.filename)
		}
		case 'audio':
		case 'video':
			return fail(`${part.type} content is unsupported by Namzu messages`)
	}
}

function userMessage(content: Extract<AGUIMessage, { role: 'user' }>['content']): UserMessage {
	if (typeof content === 'string') return { role: 'user', content }
	const text: string[] = []
	const attachments: MessageAttachment[] = []
	for (const part of content) {
		if (part.type === 'text') text.push(part.text)
		else attachments.push(attachment(part))
	}
	return {
		role: 'user',
		content: text.join('\n'),
		...(attachments.length > 0 ? { attachments } : {}),
	}
}

/**
 * Explicitly admit client history selected by the host; the adapter never calls this automatically.
 *
 * Activity and reasoning messages are display-only and are omitted, including encrypted reasoning.
 * Transport IDs, names and metadata are not prompt content or Namzu provider replay state. Encrypted
 * content on conversational messages/tool calls is refused because it cannot be faithfully restored.
 * The sole metadata projection is a tool's `namzu.isError === true` failure verdict, preserving
 * failures returned through the official AG-UI client. It never conveys execution authority.
 * User text parts are joined with newlines; attachments keep their relative order in the SDK's
 * separate attachment channel. URL/reference resolution and audio/video are unsupported.
 *
 * Every tool round must be complete, contiguous (apart from display-only messages), and unambiguous.
 * This converts historical results; it cannot approve or resume a pending client tool execution.
 * Admission failures throw AGUIRequestError with status 422 and code INVALID_MESSAGE_HISTORY.
 */
export function toNamzuMessages(
	messages: readonly AGUIMessage[],
	options: AGUIMessageOptions = {},
): Message[] {
	const result: Message[] = []
	const messageIds = new Set<string>()
	const callIds = new Set<string>()
	const pending = new Set<string>()
	const answered = new Set<string>()
	for (const [index, raw] of messages.entries()) {
		const parsed = MessageSchema.safeParse(raw)
		if (!parsed.success) return fail(`invalid message at index ${index}`)
		const message = parsed.data
		if (!message.id) return fail(`empty message ID at index ${index}`)
		if (messageIds.has(message.id)) return fail(`duplicate message ID at index ${index}`)
		messageIds.add(message.id)
		if (message.role === 'activity' || message.role === 'reasoning') continue
		if (message.encryptedValue !== undefined) {
			return fail(`encrypted ${message.role} content is unsupported`)
		}
		if (pending.size > 0 && message.role !== 'tool') {
			return fail('unresolved tool calls must be answered before another conversational message')
		}
		switch (message.role) {
			case 'system':
			case 'developer':
				if (options.allowSystemMessages !== true) {
					return fail(`${message.role} messages require allowSystemMessages: true`)
				}
				result.push({ role: 'system', content: message.content })
				break
			case 'user':
				result.push(userMessage(message.content))
				break
			case 'assistant': {
				const toolCalls: ToolCall[] = []
				for (const call of message.toolCalls ?? []) {
					if (!call.id || !call.function.name) return fail('tool calls require an ID and name')
					if (callIds.has(call.id)) return fail('duplicate tool call ID')
					if (call.encryptedValue !== undefined) return fail('encrypted tool calls are unsupported')
					try {
						JSON.parse(call.function.arguments)
					} catch {
						return fail('tool call has invalid JSON arguments')
					}
					callIds.add(call.id)
					pending.add(call.id)
					toolCalls.push({
						id: call.id,
						type: 'function',
						function: { name: call.function.name, arguments: call.function.arguments },
					})
				}
				result.push({
					role: 'assistant',
					content: message.content ?? null,
					...(toolCalls.length > 0 ? { toolCalls } : {}),
				})
				break
			}
			case 'tool':
				if (answered.has(message.toolCallId)) {
					return fail('duplicate tool result')
				}
				if (!pending.delete(message.toolCallId)) {
					return fail('unmatched tool result')
				}
				answered.add(message.toolCallId)
				result.push({
					role: 'tool',
					toolCallId: message.toolCallId,
					content: message.content,
					...(message.error !== undefined || hasToolErrorMetadata(message.metadata)
						? { isError: true }
						: {}),
				})
				break
		}
	}
	if (pending.size > 0) return fail('history ends with unresolved tool calls')
	return result
}
