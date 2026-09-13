import type { MessageRole } from '../../types/message/index.js'
import { type CompactedToolMetadata, compactedToolMetadata } from './compaction-provenance.js'

interface CompactedText extends CompactedToolMetadata {
	role: MessageRole
	text: string
	summary?: true
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

/**
 * Exact text only: do not stringify binary blocks or invent separators.
 * Plain-string parts keep their historical ordinals. Block text is appended
 * after that prefix, in message/block order, so durable seq/part addresses
 * from before block indexing still resolve to the same original text.
 */
export function compactedTexts(messages: unknown): CompactedText[] {
	if (!Array.isArray(messages)) throw new Error('Invalid shed messages.')
	const strings: CompactedText[] = []
	const blocks: CompactedText[] = []
	const metadata = compactedToolMetadata(messages)
	for (const [index, value] of messages.entries()) {
		const message = record(value)
		if (
			!message ||
			typeof message.role !== 'string' ||
			!['system', 'user', 'assistant', 'tool'].includes(message.role)
		)
			throw new Error('Invalid shed message.')
		const role = message.role as MessageRole
		if (typeof message.content === 'string') {
			strings.push({
				role,
				text: message.content,
				...metadata[index],
				...(role === 'system' && record(message.source)?.type === 'compaction-summary'
					? { summary: true as const }
					: {}),
			})
		} else if (role === 'tool' && Array.isArray(message.content)) {
			for (const value of message.content) {
				const block = record(value)
				if (block?.type === 'text' && typeof block.text === 'string')
					blocks.push({ role, text: block.text, ...metadata[index] })
				else if (
					!block ||
					(block.type !== 'image' && block.type !== 'document') ||
					typeof block.data !== 'string' ||
					typeof block.mediaType !== 'string'
				)
					throw new Error('Invalid shed tool content block.')
			}
		}
	}
	return strings.concat(blocks)
}
