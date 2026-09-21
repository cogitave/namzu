import {
	type Message,
	type QueryParams,
	type StopReason,
	type Turn,
	createAssistantMessage,
	createUserMessage,
	query,
} from '@namzu/sdk'

import { LiveError } from './errors.js'
import type { LiveMessage, LiveModel, LiveModelEvent, LiveModelTurn } from './types.js'

export type NamzuQueryConfig = Omit<QueryParams, 'messages' | 'signal' | 'systemPrompt'>

export interface NamzuModelOptions {
	/** Build fresh SDK configuration for one live turn. This callback must be synchronous. */
	readonly createQueryParams: (turn: LiveModelTurn) => NamzuQueryConfig
}

const SPEAKABLE_STOP_REASONS = new Set<StopReason>(['end_turn', 'stop_condition'])

function mapMessage(message: LiveMessage): Message {
	const mapped =
		message.role === 'user'
			? createUserMessage(message.content)
			: createAssistantMessage(message.content)
	mapped.timestamp = message.createdAt
	return mapped
}

function validateQueryConfig(config: NamzuQueryConfig): void {
	if (config.outputGuardrails !== undefined && config.outputGuardrails.length > 0) {
		throw new LiveError(
			'unsafe_query_config',
			'Output guardrails can rewrite text after it has been synthesized; use a buffered model path.',
		)
	}
	if (config.reviewAnswer !== undefined) {
		throw new LiveError(
			'unsafe_query_config',
			'Answer review can reject text after it has streamed; use a buffered model path.',
		)
	}
	if (config.structuredOutput !== undefined) {
		throw new LiveError(
			'unsafe_query_config',
			'Structured output is not a speakable live-turn contract.',
		)
	}
}

function assertSpeakableTurn(turn: Turn): asserts turn is Turn & { stopReason: StopReason } {
	if (
		turn.status !== 'completed' ||
		!turn.stopReason ||
		!SPEAKABLE_STOP_REASONS.has(turn.stopReason)
	) {
		throw new LiveError(
			'turn_not_speakable',
			`Namzu turn ${turn.id} in session ${turn.sessionId} settled as ${turn.status} (${turn.stopReason ?? 'no stop reason'}).`,
		)
	}
}

export class NamzuModel implements LiveModel {
	private readonly options: NamzuModelOptions

	constructor(options: NamzuModelOptions) {
		this.options = options
	}

	async *stream(turn: LiveModelTurn): AsyncIterable<LiveModelEvent> {
		const config = this.options.createQueryParams(turn)
		validateQueryConfig(config)
		const generator = query({
			...config,
			messages: turn.messages.map(mapMessage),
			signal: turn.signal,
			systemPrompt: turn.instructions,
		})

		let emittedText = false
		let settled: Turn
		try {
			for (;;) {
				const next = await generator.next()
				if (next.done) {
					settled = next.value
					break
				}
				if (next.value.type !== 'text_delta' || next.value.text.length === 0) continue
				emittedText = true
				yield {
					messageId: next.value.messageId,
					text: next.value.text,
					type: 'text_delta',
				}
			}
		} catch (error) {
			if (error instanceof LiveError) throw error
			throw new LiveError('query_failed', error instanceof Error ? error.message : String(error), {
				cause: error,
			})
		}

		const ids = { sessionId: settled.sessionId, turnId: settled.id }
		if (turn.signal.aborted && settled.status === 'cancelled') {
			yield { ...ids, type: 'cancelled' }
			return
		}
		assertSpeakableTurn(settled)
		if (!emittedText && settled.result) {
			yield { messageId: settled.id, text: settled.result, type: 'text_delta' }
		}
		yield {
			...ids,
			type: 'usage',
			usage: {
				cacheCreationTokens: settled.tokenUsage.cacheWriteTokens,
				completionTokens: settled.tokenUsage.completionTokens,
				promptCachedTokens: settled.tokenUsage.cachedTokens,
				promptTokens: settled.tokenUsage.promptTokens,
				totalTokens: settled.tokenUsage.totalTokens,
			},
		}
		yield {
			...ids,
			result: settled.result ?? '',
			stopReason: settled.stopReason,
			type: 'completed',
		}
	}
}
