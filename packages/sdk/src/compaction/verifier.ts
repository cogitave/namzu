import type { CompactionConfig } from '../config/runtime.js'
import type { Message } from '../types/message/index.js'
import type { LLMProvider } from '../types/provider/interface.js'
import type { WorkingStateManager } from './manager.js'
import { serializeState } from './serializer.js'

const VERIFICATION_PROMPT = `You are a context compaction verifier. You are given a structured state summary extracted from a conversation, plus a truncated excerpt of the older conversation that was summarized.

Your job: determine if the structured state captures all important information from the conversation excerpt. Important information includes:
- The user's original task and any follow-up requirements
- Key decisions made during the conversation
- Errors encountered and how they were resolved
- Files that were read, created, or modified
- Important discoveries or constraints

If the structured state is complete, respond with exactly: COMPLETE

If something important is missing, respond with a brief bullet list of the missing items (no preamble, just the bullets). Each bullet should be a single concise sentence.`

function truncateMessages(messages: Message[], budget: number): string {
	const lines: string[] = []
	let charCount = 0

	for (const msg of messages) {
		if (!msg.content) continue
		const prefix = `[${msg.role}]: `
		const content = msg.content

		if (charCount + prefix.length + content.length > budget) {
			const remaining = budget - charCount - prefix.length
			if (remaining > 0) {
				lines.push(`${prefix}${content.slice(0, remaining)}...`)
			}
			break
		}

		lines.push(`${prefix}${content}`)
		charCount += prefix.length + content.length
	}

	return lines.join('\n\n')
}

export async function buildVerifiedSummary(
	manager: WorkingStateManager,
	olderMessages: Message[],
	provider: LLMProvider,
	config: CompactionConfig,
): Promise<string> {
	const serialized = serializeState(manager.getState())

	if (manager.slotCount() >= config.richStateThreshold) {
		return serialized
	}

	if (!config.llmVerification) {
		return serialized
	}

	const conversationExcerpt = truncateMessages(olderMessages, config.convoTextBudget)

	if (!conversationExcerpt.trim()) {
		return serialized
	}

	const verificationMessages: Message[] = [
		{
			role: 'system' as const,
			content: VERIFICATION_PROMPT,
		},
		{
			role: 'user' as const,
			content: `## Structured State\n\n${serialized}\n\n## Conversation Excerpt\n\n${conversationExcerpt}`,
		},
	]

	const response = await provider.chat({
		model: '',
		messages: verificationMessages,
		maxTokens: config.llmVerificationMaxTokens,
		temperature: 0,
	})

	const responseText = response.message.content?.trim() ?? ''

	if (responseText === 'COMPLETE') {
		return serialized
	}

	return `${serialized}\n\n## LLM Verification Additions\n\n${responseText}`
}
