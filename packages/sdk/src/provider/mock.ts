import { FALLBACK_MOCK_MODEL } from '../constants/provider/index.js'
import type { TokenUsage } from '../types/common/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	MockScript,
	MockTurn,
	StreamChunk,
} from '../types/provider/index.js'

const EMPTY_USAGE: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/**
 * A model you script.
 *
 * The previous mock could only emit text: it never yielded
 * `delta.toolCalls`, and `MOCK_CAPABILITIES.supportsTools` was `false`, so
 * capability negotiation stripped the tool surface before a request was
 * even built. A consumer writing a custom tool therefore had no supported
 * way to test that the agent loop calls it — and namzu's own maintainers
 * hand-rolled eight `implements LLMProvider` fakes across seven test files
 * to work around exactly that, each re-implementing the delta bucketing
 * and `toolCallEnd` framing that `streamProviderTurn` exists to hide.
 *
 * Scripted turns are emitted with the same frame sequence a real driver
 * produces — per-tool `index`, id and name first, then argument fragments,
 * then the block-close signal — so a test exercises the real consumer path
 * rather than a shortcut through it.
 */
export class MockLLMProvider implements LLMProvider {
	readonly id = 'mock'
	readonly name = 'Mock LLM Provider'

	private readonly model: string
	private readonly responseDelayMs: number
	private readonly turns: readonly MockTurn[]
	private readonly nextTurn?: (params: ChatCompletionParams, turnIndex: number) => MockTurn
	private readonly onRequest?: (params: ChatCompletionParams) => void
	private turnIndex = 0

	/** Every request this provider has received, in order. */
	readonly requests: ChatCompletionParams[] = []

	constructor(config: MockScript = {}) {
		this.model = config.model ?? FALLBACK_MOCK_MODEL
		this.responseDelayMs = config.responseDelayMs ?? 0
		this.onRequest = config.onRequest
		this.nextTurn = config.nextTurn
		this.turns = config.turns ?? [{ text: config.responseText ?? 'Mock provider response' }] // Back-compat: the old single-string config becomes a one-turn script.
	}

	/** Reset the script pointer and captured requests between cases. */
	reset(): void {
		this.turnIndex = 0
		this.requests.length = 0
	}

	private async delay(): Promise<void> {
		if (this.responseDelayMs <= 0) return
		await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs))
	}

	/**
	 * The turn to play. A script shorter than the run repeats its last
	 * entry, so a test that only cares about the first two turns does not
	 * have to pad the rest — and a loop bug shows up as repetition rather
	 * than an exhausted-script crash.
	 */
	private resolveTurn(params: ChatCompletionParams): MockTurn {
		const index = this.turnIndex++
		if (this.nextTurn) return this.nextTurn(params, index)
		return this.turns[Math.min(index, this.turns.length - 1)] ?? { text: '' }
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		await this.delay()
		this.requests.push(params)
		this.onRequest?.(params)

		const turn = this.resolveTurn(params)
		const id = `mock-${this.turnIndex}`

		if (turn.error !== undefined) {
			// Surfaced as a thrown error, the way a driver reports a request
			// that never produced a stream.
			throw Object.assign(new Error(turn.error.message), {
				...(turn.error.status !== undefined ? { status: turn.error.status } : {}),
			})
		}

		const text = turn.text ?? ''
		const chunkSize = turn.chunkSize ?? 8
		let emitted = 0

		for (let i = 0; i < text.length; i += chunkSize) {
			if (turn.throwAfterChunks !== undefined && emitted >= turn.throwAfterChunks) {
				throw new Error(turn.throwMessage ?? 'mock stream failure')
			}
			yield { id, delta: { content: text.slice(i, i + chunkSize) } }
			emitted++
		}

		const toolCalls = turn.toolCalls ?? []

		for (const [index, call] of toolCalls.entries()) {
			const callId = call.id ?? `call_${this.turnIndex}_${index}`
			yield {
				id,
				delta: {
					toolCalls: [
						{ index, id: callId, type: 'function', function: { name: call.name, arguments: '' } },
					],
				},
			}

			// Arguments arrive as JSON fragments, which is what forces the
			// consumer's partial-JSON buffering to be exercised.
			const args = JSON.stringify(call.args ?? {})
			const step = call.argChunkSize ?? Math.max(1, Math.ceil(args.length / 3))
			for (let i = 0; i < args.length; i += step) {
				yield {
					id,
					delta: { toolCalls: [{ index, function: { arguments: args.slice(i, i + step) } }] },
				}
			}

			if (call.truncateArguments !== true) {
				yield { id, delta: { toolCallEnd: { index, id: callId } } }
			}
		}

		yield {
			id,
			delta: {},
			finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
			usage: { ...EMPTY_USAGE, ...turn.usage },
		}
	}

	async listModels() {
		return [
			{
				id: this.model,
				name: 'Mock Model',
				contextWindow: 32_000,
				maxOutputTokens: 8_000,
				inputPrice: 0,
				outputPrice: 0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
		]
	}

	async healthCheck() {
		await this.delay()
		return true
	}
}
