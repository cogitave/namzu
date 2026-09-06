import type { CompactionConfig } from '../config/runtime.js'
import { collectChatCompletion } from '../provider/collect-chat-completion.js'
import { resolveStreamIdleTimeoutMs, withStreamIdleTimeout } from '../provider/idle-timeout.js'
import type { TokenUsage } from '../types/common/index.js'
import type { Message, MessageAttachment, ToolResultBlock } from '../types/message/index.js'
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

function* attachmentExcerpt(
	attachment: MessageAttachment | Exclude<ToolResultBlock, { type: 'text' }>,
): Generator<string> {
	const kind =
		attachment.type === 'stored'
			? attachment.kind
			: attachment.type === 'document'
				? 'document'
				: 'image'
	yield `[${kind}`
	if ('name' in attachment && attachment.name) {
		yield ' "'
		yield attachment.name
		yield '"'
	}
	yield ': '
	yield attachment.mediaType
	yield ' — not included in this text excerpt]'
}

/** Visible evidence only: never stringify a whole message or its attachment bytes. */
function* conversationExcerpt(messages: readonly Message[]): Generator<string> {
	let first = true
	for (const message of messages) {
		const hasDetails =
			message.role === 'tool' ||
			(message.role === 'assistant' && message.toolCalls?.length) ||
			(message.role === 'user' && message.attachments?.length)
		if (!message.content && !hasDetails) continue
		if (!first) yield '\n\n'
		first = false
		yield `[${message.role}]: `
		if (message.role === 'tool') {
			yield '[tool result '
			yield message.toolCallId
			yield `; isError=${message.isError === true}]\n`
		}
		if (typeof message.content === 'string') yield message.content
		else if (message.content) {
			for (const [index, block] of message.content.entries()) {
				if (index > 0) yield '\n'
				if (block.type === 'text') yield block.text
				else yield* attachmentExcerpt(block)
			}
		}
		if (message.role === 'assistant') {
			for (const call of message.toolCalls ?? []) {
				yield '\n[tool call '
				yield call.id
				yield '] '
				yield call.function.name
				yield '('
				yield call.function.arguments
				yield ')'
			}
		}
		if (message.role === 'user') {
			for (const attachment of message.attachments ?? []) {
				yield '\n'
				yield* attachmentExcerpt(attachment)
			}
		}
	}
}

function truncateMessages(messages: readonly Message[], budget: number): string {
	if (budget <= 0) return ''
	const parts: string[] = []
	let remaining = budget
	for (const part of conversationExcerpt(messages)) {
		if (part.length > remaining) {
			parts.push(part.slice(0, remaining))
			// Role labels, separators and the omission marker all consume the
			// same budget. Consume fragments lazily so huge arguments and rich
			// results cannot bypass the cap or require a full serialized copy.
			let prefix = parts.join('').slice(0, budget - 1)
			const last = prefix.charCodeAt(prefix.length - 1)
			if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1)
			return `${prefix}…`
		}
		parts.push(part)
		remaining -= part.length
	}
	return parts.join('')
}

/**
 * Narrow sink for the tokens a side-channel model call spends.
 *
 * The verifier runs outside the iteration loop, so its usage never reached
 * `runMgr.accumulateUsage` and the guard could not see it — and it fires
 * exactly when the context is largest, making it the most expensive call
 * the run does not count. A one-method sink keeps the compaction layer
 * from depending on `RunPersistence`.
 */
export type UsageSink = (usage: TokenUsage) => void

/** Cancellation and stream-liveness policy for a compaction verifier call. */
export interface CompactionVerificationOptions {
	/** Stop before provider work starts, or close an in-flight verifier transport. */
	readonly signal?: AbortSignal
	/**
	 * Milliseconds without a verifier chunk before the provider stream is
	 * treated as stalled. Defaults to the SDK's finite shared bound. Set `0`
	 * only for explicit unbounded compatibility.
	 */
	readonly streamIdleTimeoutMs?: number
}

export async function buildVerifiedSummary(
	manager: WorkingStateManager,
	olderMessages: Message[],
	provider: LLMProvider,
	config: CompactionConfig,
	onUsage?: UsageSink,
	/**
	 * The run's model. Required in practice: this used to send `model: ''`,
	 * which some drivers quietly default and others reject outright — on
	 * some backends the model id IS the endpoint. So compaction's verifier failed
	 * exactly on the providers where a long run most needs it, and the
	 * failure surfaced as compaction killing the run it exists to save.
	 */
	model?: string,
	options: CompactionVerificationOptions = {},
): Promise<string> {
	options.signal?.throwIfAborted()
	const providerWithIdleBound = withStreamIdleTimeout(provider, {
		idleTimeoutMs: resolveStreamIdleTimeoutMs(options.streamIdleTimeoutMs),
	})
	return await buildVerifiedSummaryWithProvider(
		manager,
		olderMessages,
		providerWithIdleBound,
		config,
		onUsage,
		model,
		options.signal,
	)
}

/**
 * Query-only seam for a provider whose idle/retry/fallback order was already
 * composed at run admission. Wrapping that chain again would put an idle
 * timer around retry backoff and misclassify a healthy recovery pause as a
 * stalled stream. This symbol is intentionally absent from the package barrel.
 */
export async function buildVerifiedSummaryWithBoundedProvider(
	manager: WorkingStateManager,
	olderMessages: Message[],
	provider: LLMProvider,
	config: CompactionConfig,
	onUsage?: UsageSink,
	model?: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted()
	return await buildVerifiedSummaryWithProvider(
		manager,
		olderMessages,
		provider,
		config,
		onUsage,
		model,
		signal,
	)
}

async function buildVerifiedSummaryWithProvider(
	manager: WorkingStateManager,
	olderMessages: Message[],
	provider: LLMProvider,
	config: CompactionConfig,
	onUsage?: UsageSink,
	model?: string,
	signal?: AbortSignal,
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

	const response = await collectChatCompletion(
		provider.chatStream({
			model: model ?? '',
			messages: verificationMessages,
			maxTokens: config.llmVerificationMaxTokens,
			temperature: 0,
			...(signal ? { signal } : {}),
		}),
	)

	onUsage?.(response.usage)

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
