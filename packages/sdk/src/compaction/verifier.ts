import type { CompactionConfig } from '../config/runtime.js'
import { collect } from '../provider/collect.js'
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

	const response = await collect(
		provider.chatStream({
			model: '',
			messages: verificationMessages,
			maxTokens: config.llmVerificationMaxTokens,
			temperature: 0,
		}),
	)

	const responseText = response.message.content?.trim() ?? ''

	// `COMPLETE` is the verifier saying it found nothing to add. An EMPTY reply
	// says the same thing by accident — a turn truncated at
	// `llmVerificationMaxTokens`, a refusal, or a provider that returned no
	// content at all — and used to fall through to the append below, stamping a
	// bare `## LLM Verification Additions` heading with nothing under it. That
	// empty promise then rides in the compaction summary, and therefore in every
	// subsequent system prompt, for the rest of the run. A heading with no body
	// is not a verification result; treat a silent verifier the same as one that
	// had nothing to say.
	if (responseText === 'COMPLETE' || responseText.length === 0) {
		return serialized
	}

	return `${serialized}\n\n## LLM Verification Additions\n\n${responseText}`
}
