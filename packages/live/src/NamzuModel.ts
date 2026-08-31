import {
	type Message,
	type QueryParams,
	type Run,
	type StopReason,
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
	readonly label?: string
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

function assertSpeakableRun(run: Run): asserts run is Run & { stopReason: StopReason } {
	if (
		run.status !== 'completed' ||
		!run.stopReason ||
		!SPEAKABLE_STOP_REASONS.has(run.stopReason)
	) {
		throw new LiveError(
			'run_not_speakable',
			`Namzu run ${run.id} settled as ${run.status} (${run.stopReason ?? 'no stop reason'}).`,
		)
	}
}

export class NamzuModel implements LiveModel {
	readonly label: string
	private readonly options: NamzuModelOptions

	constructor(options: NamzuModelOptions) {
		this.options = options
		this.label = options.label ?? 'namzu'
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
		let run: Run
		try {
			for (;;) {
				const next = await generator.next()
				if (next.done) {
					run = next.value
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

		if (turn.signal.aborted && run.status === 'cancelled') {
			yield { runId: run.id, type: 'cancelled' }
			return
		}
		assertSpeakableRun(run)
		if (!emittedText && run.result) {
			yield { messageId: run.id, text: run.result, type: 'text_delta' }
		}
		yield {
			runId: run.id,
			type: 'usage',
			usage: {
				cacheCreationTokens: run.tokenUsage.cacheWriteTokens,
				completionTokens: run.tokenUsage.completionTokens,
				promptCachedTokens: run.tokenUsage.cachedTokens,
				promptTokens: run.tokenUsage.promptTokens,
				totalTokens: run.tokenUsage.totalTokens,
			},
		}
		yield {
			result: run.result ?? '',
			runId: run.id,
			stopReason: run.stopReason,
			type: 'completed',
		}
	}
}
