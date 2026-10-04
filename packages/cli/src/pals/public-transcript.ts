import { type AssistantMessage, selectAssistantText } from '@namzu/sdk'

/** Display projection only; journal messages and model replay remain untouched. */
export function palPublicAssistantText(message: AssistantMessage): string | undefined {
	if (message.toolCalls?.length) return undefined
	const content = message.content ?? ''
	if (!message.textParts?.length) return content.trim() ? content : undefined
	// Edited or compacted messages can supersede the original public parts.
	if (selectAssistantText(message.textParts) !== content)
		return content.trim() ? content : undefined
	const delivered = message.textParts.filter((part) => part.phase !== 'commentary')
	if (!delivered.length) return undefined
	const text = selectAssistantText(delivered)
	return text.trim() ? text : undefined
}
