import type { CompactionConfig } from '../config/runtime.js'
import { chatWithRetry } from '../runtime/query/model-call.js'
import type { Message } from '../types/message/index.js'
import type { LLMProvider } from '../types/provider/interface.js'
import { getRootLogger } from '../utils/logger.js'
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

/** Section header under which {@link buildVerifiedSummary} renders its additions. */
const ADDITIONS_HEADER = '## LLM Verification Additions'

/**
 * The two halves of a verified summary, kept apart.
 *
 * `serialized` is re-derived from the {@link WorkingStateManager} on every
 * compaction pass, so it is disposable: a later pass regenerates it. `additions`
 * is not — it is what the verifier found in the older conversation that the
 * structured state does NOT hold, and if a later pass does not carry it forward it
 * exists nowhere. Compaction needs the two separately in order to carry the second
 * without duplicating the first (ses_015 pre-freeze R4 B2).
 */
export interface VerifiedSummaryParts {
	/** The working state, serialized on this pass. */
	serialized: string
	/** Verifier findings absent from the state; `''` when it found nothing to add. */
	additions: string
}

export async function buildVerifiedSummaryParts(
	manager: WorkingStateManager,
	olderMessages: Message[],
	provider: LLMProvider,
	config: CompactionConfig,
): Promise<VerifiedSummaryParts> {
	const serialized = serializeState(manager.getState())

	if (manager.slotCount() >= config.richStateThreshold) {
		return { serialized, additions: '' }
	}

	if (!config.llmVerification) {
		return { serialized, additions: '' }
	}

	const conversationExcerpt = truncateMessages(olderMessages, config.convoTextBudget)

	if (!conversationExcerpt.trim()) {
		return { serialized, additions: '' }
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

	// Retry transient throttle/server/network blips: the provider adapter no
	// longer retries internally, so an unwrapped call would fail the whole
	// compaction pass on a single 429/503 (ses_015 fix-batch). No signal is in
	// scope here; chatWithRetry supplies its own bounded budget.
	const response = await chatWithRetry(
		provider,
		{
			model: '',
			messages: verificationMessages,
			maxTokens: config.llmVerificationMaxTokens,
			temperature: 0,
		},
		{ log: getRootLogger() },
	)

	const responseText = response.message.content?.trim() ?? ''

	if (responseText === 'COMPLETE' || responseText === '') {
		return { serialized, additions: '' }
	}

	return { serialized, additions: responseText }
}

/**
 * The verified summary as one block: the serialized state, plus the verifier's
 * additions under {@link ADDITIONS_HEADER} when it found any.
 */
export async function buildVerifiedSummary(
	manager: WorkingStateManager,
	olderMessages: Message[],
	provider: LLMProvider,
	config: CompactionConfig,
): Promise<string> {
	const { serialized, additions } = await buildVerifiedSummaryParts(
		manager,
		olderMessages,
		provider,
		config,
	)
	return additions ? `${serialized}\n\n${ADDITIONS_HEADER}\n\n${additions}` : serialized
}
