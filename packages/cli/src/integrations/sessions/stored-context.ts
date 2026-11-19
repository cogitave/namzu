/**
 * What a conversation's log says about its own context, read without an
 * engine. The desktop host (for a conversation it has not loaded) and the
 * terminal's resume both call this, so a reopened conversation shows the last
 * figures it had instead of "not counted yet".
 *
 * The log is the one owner of these figures: nothing here is copied anywhere
 * else, and a live notice from the engine always replaces what is read here.
 */

import {
	type Message,
	type SessionEvent,
	type SessionRecord,
	analyzeContextUsage,
	lookupContextWindow,
} from '@namzu/sdk'

import { createContextTracker } from '../../commands/desktop-context.js'

export interface StoredContext {
	/** The conversation's size in tokens. */
	readonly tokens: number
	readonly windowTokens: number
	/** `provider` when the AI service counted it, `estimate` otherwise. */
	readonly measuredBy: 'provider' | 'estimate'
	readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
	/** True when the figure was read from the log; false when it was estimated from the messages. */
	readonly fromRecord: boolean
	/** A shortening rewrote the history after the last count from the AI service. */
	readonly sizeOutOfDate?: boolean
}

/** The figure a history read carries so the context ring can be drawn before any reply. */
export function historyUsage(stored: StoredContext) {
	return {
		contextTokens: stored.tokens,
		contextWindowTokens: stored.windowTokens,
		measuredBy: stored.measuredBy,
		fromRecord: stored.fromRecord,
		...(stored.sizeOutOfDate ? { sizeOutOfDate: true } : {}),
	}
}

/** The model the log last started a turn with, if any. */
export function lastStoredModel(records: readonly SessionRecord[]): string | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		if (record?.type === 'turn_started' && record.config.model) return record.config.model
	}
	return undefined
}

/**
 * The last context figures the log holds. With none, an estimate from the
 * stored messages, but only where the model's window is known; otherwise
 * `null`, so a caller says "not counted yet" rather than guessing.
 */
export function storedContext(
	records: readonly SessionRecord[],
	messages: readonly Message[],
): StoredContext | null {
	const tracker = createContextTracker()
	const key = 'stored'
	for (const record of records) tracker.observe(key, record as unknown as SessionEvent)
	const figures = tracker.figures(key)
	if (figures?.windowTokens && figures.windowTokens > 0 && figures.tokens !== undefined) {
		return {
			tokens: figures.tokens,
			windowTokens: figures.windowTokens,
			measuredBy: figures.measuredBy ?? 'estimate',
			...(figures.windowSource ? { windowSource: figures.windowSource } : {}),
			fromRecord: true,
			...(figures.sizeOutOfDate ? { sizeOutOfDate: true } : {}),
		}
	}
	if (messages.length === 0) return null
	const windowTokens = figures?.windowTokens ?? lookupContextWindow(lastStoredModel(records))
	if (!windowTokens || windowTokens <= 0) return null
	const breakdown = analyzeContextUsage({
		windowTokens,
		windowSource: 'auto',
		autoCompact: true,
		messages,
	})
	return {
		tokens: Math.round(breakdown.totalTokens),
		windowTokens,
		measuredBy: 'estimate',
		windowSource: figures?.windowTokens ? (figures.windowSource ?? 'model-table') : 'model-table',
		fromRecord: false,
	}
}

export type StoredTurnStatus = 'completed' | 'cancelled' | 'failed' | 'paused' | 'interrupted'

/**
 * How the conversation's last turn ended. A log that stops inside a turn (no
 * completion, no failure, no pause after its start) is `interrupted`: the
 * process that wrote it is gone, which is what a crash or a kill leaves.
 * `undefined` when no turn ever started.
 */
export function lastTurnStatus(records: readonly SessionRecord[]): StoredTurnStatus | undefined {
	let status: StoredTurnStatus | undefined
	for (const record of records) {
		if (record.type === 'turn_started' || record.type === 'turn_resuming') status = 'interrupted'
		else if (record.type === 'turn_paused') status = 'paused'
		else if (record.type === 'turn_failed') status = 'failed'
		else if (record.type === 'turn_completed')
			status = record.settlement.status === 'cancelled' ? 'cancelled' : 'completed'
	}
	return status
}
