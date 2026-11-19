import type { Message, SessionRecord } from '@namzu/sdk'

import { gatherContext } from '../integrations/sessions/context-gather.js'
import { storedContext } from '../integrations/sessions/stored-context.js'
import { type ContextDetail, type ContextReport, buildContextReport } from './desktop-context.js'

/**
 * The context panel's answer for a conversation no engine holds: the last count the log
 * recorded, or an estimate from the stored messages where the model's window is known.
 * Null when neither exists, so the panel says "not counted yet" instead of guessing.
 * The breakdown by part is empty (no system prompt or tool list is read without an engine);
 * only the total and the free room are drawn.
 */
export async function storedContextReport(input: {
	readonly sessionId: string
	readonly detail: ContextDetail
	readonly records: readonly SessionRecord[]
	readonly messages: readonly Message[]
}): Promise<ContextReport | null> {
	const stored = storedContext(input.records, input.messages)
	if (!stored) return null
	const gathering = await gatherContext({
		context: {
			tokens: stored.tokens,
			windowTokens: stored.windowTokens,
			measured: stored.measuredBy === 'provider',
			...(stored.windowSource ? { windowSource: stored.windowSource } : {}),
		},
		autoCompact: true,
		tools: [],
		messages: [],
		instructionFiles: [],
		mcpInstructions: [],
		skills: [],
		agents: [],
		displayPath: (path) => path,
	})
	return buildContextReport({
		sessionId: input.sessionId,
		detail: input.detail,
		figures: {
			tokens: stored.tokens,
			windowTokens: stored.windowTokens,
			measuredBy: stored.measuredBy,
			...(stored.windowSource ? { windowSource: stored.windowSource } : {}),
			...(stored.sizeOutOfDate ? { sizeOutOfDate: true } : {}),
			version: 0,
		},
		autoCompact: true,
		gathering,
		stored: stored.fromRecord ? 'record' : 'estimate',
	})
}
