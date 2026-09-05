import { CHARS_PER_TOKEN } from '../constants/limits.js'
import type { Message, MessageAttachment, ToolResultBlock } from '../types/message/index.js'

// Heuristic allowances, not provider billing formulas or upper bounds. Encoded
// byte length depends on compression, not the number of visual tokens. The
// provider's measured prompt usage replaces these guesses after the next call.
const IMAGE_TOKENS = 1_024
const DOCUMENT_TOKENS = 4_096
const OMITTED_IMAGE_TOKENS = 64

function richTokens(block: Exclude<ToolResultBlock, { type: 'text' }> | MessageAttachment): number {
	if (block.type === 'stored') return block.kind === 'image' ? IMAGE_TOKENS : DOCUMENT_TOKENS
	if (block.type === 'document') return DOCUMENT_TOKENS
	return block.modelOmission ? OMITTED_IMAGE_TOKENS : IMAGE_TOKENS
}

/**
 * Provider-neutral prompt estimate shared by triggers, retention and eviction.
 *
 * Text and tool inputs use the existing characters-per-token approximation.
 * Images and documents have an explicit allowance independent of compression
 * and of whether the bytes are inline or stored externally. Without dimensions,
 * page counts and a provider tokenizer their exact cost is unknown. In
 * particular, serialized base64 is never treated as model-visible prose.
 */
export function estimateMessageTokens(message: Message): number {
	let chars = 0
	let rich = 0
	if (typeof message.content === 'string') chars += message.content.length
	else if (message.content) {
		for (const block of message.content) {
			if (block.type === 'text') chars += block.text.length
			else {
				rich += richTokens(block)
				if (block.type === 'document') chars += block.name?.length ?? 0
			}
		}
	}
	if (message.role === 'assistant') {
		for (const call of message.toolCalls ?? []) {
			chars += call.function.name.length + call.function.arguments.length
		}
	}
	if (message.role === 'user') {
		for (const attachment of message.attachments ?? []) {
			rich += richTokens(attachment)
			if (attachment.type === 'document' || attachment.type === 'stored') {
				chars += attachment.name?.length ?? 0
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + rich
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}
