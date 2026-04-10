import { serializeState } from '../../../../compaction/serializer.js'
import { buildVerifiedSummary } from '../../../../compaction/verifier.js'
import { CHARS_PER_TOKEN } from '../../../../constants/limits.js'
import { createSystemMessage } from '../../../../types/message/index.js'
import type { IterationContext } from './context.js'

const COMPACTION_HEADER =
	'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.'

function estimateTokens(ctx: IterationContext): number {
	let chars = 0
	for (const msg of ctx.sessionMgr.messages) {
		if (msg.content) {
			chars += msg.content.length
		}
		if (msg.role === 'assistant' && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				chars += tc.function.name.length + tc.function.arguments.length
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

export async function runCompactionCheck(ctx: IterationContext): Promise<void> {
	const config = ctx.compactionConfig
	if (!config) return
	if (config.strategy === 'disabled') return

	const manager = ctx.workingStateManager
	if (!manager) return

	const estimatedTokens = estimateTokens(ctx)
	const budget = ctx.sessionConfig.tokenBudget
	const usage = estimatedTokens / budget

	if (usage < config.triggerThreshold) return

	ctx.log.info('Compaction threshold reached — compacting context', {
		runId: ctx.sessionMgr.id,
		estimatedTokens,
		budget,
		usage: Math.round(usage * 100),
		triggerThreshold: config.triggerThreshold,
		slotCount: manager.slotCount(),
	})

	const messages = ctx.sessionMgr.messages
	if (messages.length < config.keepRecentMessages + 2) {
		ctx.log.debug('Not enough messages to compact', {
			messageCount: messages.length,
			keepRecentMessages: config.keepRecentMessages,
		})
		return
	}

	const systemMessages: typeof messages = []
	for (const msg of messages) {
		if (msg.role !== 'system') break
		systemMessages.push(msg)
	}
	if (systemMessages.length === 0) return

	const keepStart = messages.length - config.keepRecentMessages
	const recentMessages = messages.slice(keepStart)
	const olderMessages = messages.slice(systemMessages.length, keepStart)

	let compactedContent: string

	if (config.llmVerification && manager.slotCount() < config.richStateThreshold) {
		compactedContent = await buildVerifiedSummary(manager, olderMessages, ctx.provider, config)
	} else {
		compactedContent = serializeState(manager.getState())
	}

	const compactionMessage = createSystemMessage(`${COMPACTION_HEADER}\n\n${compactedContent}`)

	const newMessages = [...systemMessages, compactionMessage, ...recentMessages]

	const oldCount = messages.length
	messages.length = 0
	for (const msg of newMessages) {
		messages.push(msg)
	}

	const newEstimate = estimateTokens(ctx)

	ctx.log.info('Context compacted', {
		runId: ctx.sessionMgr.id,
		oldMessageCount: oldCount,
		newMessageCount: messages.length,
		removedMessages: oldCount - messages.length,
		oldTokenEstimate: estimatedTokens,
		newTokenEstimate: newEstimate,
		reductionPercent: Math.round((1 - newEstimate / estimatedTokens) * 100),
		slotCount: manager.slotCount(),
	})
}
