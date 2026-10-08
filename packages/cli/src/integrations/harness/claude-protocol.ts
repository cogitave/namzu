/** The installed engine's stream-json protocol; no Namzu provider/tool execution. */
import type {
	HarnessEvent,
	HarnessJson,
	HarnessModel,
	HarnessNativeTurn,
	MessageStopReason,
	ReviewMode,
} from '@namzu/sdk'

export function claudeRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

export function claudeString(value: unknown, max = 400): string | undefined {
	return typeof value === 'string' &&
		value.length > 0 &&
		value.length <= max &&
		!value.includes('\0')
		? value
		: undefined
}

/** Snapshot public JSON so a retained caller/frame cannot alter a native decision. */
export function claudeJson(value: unknown): HarnessJson {
	let nodes = 0
	const copy = (item: unknown, depth: number): HarnessJson => {
		if (++nodes > 20_000 || depth > 32) throw new Error('The native tool input is too large.')
		if (item === null || typeof item === 'boolean') return item
		if (typeof item === 'number' && Number.isFinite(item)) return item
		if (typeof item === 'string' && item.length <= 1_000_000) return item
		if (Array.isArray(item)) return Object.freeze(item.map((part) => copy(part, depth + 1)))
		const object = claudeRecord(item)
		if (object) {
			// fromEntries creates plain JSON objects without invoking the __proto__ setter.
			const result = Object.fromEntries(
				Object.entries(object).map(([key, part]) => {
					if (key.length > 4096) throw new Error('The native tool input is too large.')
					return [key, copy(part, depth + 1)]
				}),
			)
			return Object.freeze(result)
		}
		throw new Error('The native tool input is not JSON.')
	}
	const result = copy(value, 0)
	if (JSON.stringify(result).length > 1_000_000)
		throw new Error('The native tool input is too large.')
	return result
}

export function claudePermissionMode(mode: ReviewMode): 'default' | 'plan' {
	if (mode === 'prompt') return 'default'
	if (mode === 'plan') return 'plan'
	throw new Error('This engine currently supports supervised and plan modes only.')
}

export function claudeLaunchArgs(input: {
	model?: string
	nativeSessionId: string
	resume: boolean
	metadata?: boolean
}): string[] {
	const args = [
		'--output-format',
		'stream-json',
		'--verbose',
		'--input-format',
		'stream-json',
		'--include-partial-messages',
		'--permission-prompt-tool',
		'stdio',
		'--permission-mode',
		'default',
	]
	if (input.model) args.push('--model', input.model)
	if (input.metadata) {
		args.push(
			'--no-session-persistence',
			'--strict-mcp-config',
			'--mcp-config',
			JSON.stringify({ mcpServers: {} }),
			'--setting-sources',
			'',
			'--settings',
			JSON.stringify({ disableAllHooks: true }),
		)
	} else {
		args.push(input.resume ? '--resume' : '--session-id', input.nativeSessionId)
	}
	return args
}

export function claudeModels(
	payload: unknown,
): readonly (HarnessModel & { readonly default?: true; readonly current?: true })[] {
	const rows = claudeRecord(payload)?.models
	if (!Array.isArray(rows) || rows.length > 4096)
		throw new Error('The native engine did not return a supported model catalogue.')
	const models: (HarnessModel & { default?: true; current?: true })[] = []
	const resolvedById = new Map<string, string | undefined>()
	let defaultResolved: string | undefined
	const seen = new Set<string>()
	for (const raw of rows) {
		const row = claudeRecord(raw)
		if (!row || row.disabled === true) continue
		const value = claudeString(row.value)
		if (value === 'default') {
			// Not selectable itself, but it names which model the engine recommends.
			defaultResolved ??= claudeString(row.resolvedModel)
			continue
		}
		if (!value || value.startsWith('cc-update-required')) continue
		const resolved = claudeString(row.resolvedModel)
		const id =
			value.startsWith('claude-') || !/\d/.test(value)
				? value
				: resolved?.startsWith('claude-')
					? resolved
					: `claude-${value}`
		if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(id) || seen.has(id)) continue
		seen.add(id)
		resolvedById.set(id, resolved)
		const label = claudeString(row.displayName) ?? id
		// Effort is launch-only in this slice; do not offer an unsupported turn control.
		// The engine's own aliases (opus, sonnet, ...) always point at its current model of a
		// family; an id that names a version is a specific release, which may be an older one.
		models.push(
			Object.freeze({ id, label, ...(/\d/.test(value) ? {} : { current: true as const }) }),
		)
	}
	if (defaultResolved) {
		const index = models.findIndex(
			(model) => resolvedById.get(model.id) === defaultResolved || model.id === defaultResolved,
		)
		if (index >= 0) models[index] = Object.freeze({ ...models[index]!, default: true as const })
	}
	return Object.freeze(models)
}

type Block = {
	type: string
	text: string
	id?: string
	name?: string
	input?: HarnessJson
	partialJson: string
	completed: boolean
	authoritative?: boolean
	reasoningCompleted?: boolean
}
type NativeMessage = {
	id: string
	blocks: Map<number, Block>
	snapshotBlocks: Map<string, number>
	streamed: boolean
	activeBlock?: number
	completed: boolean
	stopReason?: MessageStopReason
}

function messageReason(value: unknown): MessageStopReason | undefined {
	const reasons: readonly MessageStopReason[] = [
		'end_turn',
		'tool_use',
		'max_tokens',
		'stop_sequence',
		'pause_turn',
		'refusal',
	]
	return reasons.includes(value as MessageStopReason) ? (value as MessageStopReason) : undefined
}

/** One serialized native operation. Older message/tool IDs never migrate into another operation. */
export class ClaudeTurnProjection {
	readonly messages = new Map<string, NativeMessage>()
	readonly tools = new Map<string, { name: string; completed: boolean }>()
	readonly events: HarnessEvent[] = []
	private currentMessage: NativeMessage | undefined
	private latestItem: string | undefined
	private authenticationFailed = false
	private finished = false

	constructor(
		readonly turn: HarnessNativeTurn,
		private readonly priorItems: ReadonlySet<string>,
	) {}

	private event(event: HarnessEvent): void {
		this.events.push(event)
	}
	private message(id: string): NativeMessage | undefined {
		if (this.priorItems.has(id)) return undefined
		let message = this.messages.get(id)
		if (!message) {
			// Without partial events, a distinct next native message confirms the
			// previous UUID block group ended. Its explicit reason stays authoritative.
			for (const previous of this.messages.values()) {
				if (
					!previous.completed &&
					!previous.streamed &&
					previous.snapshotBlocks.size > 0 &&
					previous.stopReason
				)
					this.complete(previous, this.text(previous), previous.stopReason)
			}
			message = {
				id,
				blocks: new Map(),
				snapshotBlocks: new Map(),
				streamed: false,
				completed: false,
			}
			this.messages.set(id, message)
			this.event({ ...this.turn, kind: 'message-started', nativeItemId: id })
		}
		return message
	}
	private tool(block: Block): void {
		if (!block.id || !block.name || this.priorItems.has(block.id) || this.tools.has(block.id))
			return
		let input: HarnessJson = block.input ?? {}
		if (block.partialJson) {
			try {
				input = claudeJson(JSON.parse(block.partialJson))
			} catch {
				return
			} // A full assistant snapshot can supply the authoritative input.
		}
		this.tools.set(block.id, { name: block.name, completed: false })
		this.event({
			...this.turn,
			kind: 'tool-started',
			nativeItemId: block.id,
			name: block.name,
			input,
		})
	}
	private complete(message: NativeMessage, content: string, stopReason: MessageStopReason): void {
		if (message.completed) return
		message.completed = true
		this.latestItem = message.id
		this.event({
			...this.turn,
			kind: 'message-completed',
			nativeItemId: message.id,
			content,
			stopReason,
		})
	}
	private text(message: NativeMessage): string {
		const text = [...message.blocks.entries()]
			.sort(([left], [right]) => left - right)
			.filter(([, block]) => block.type === 'text')
			.map(([, block]) => block.text)
			.join('')
		if (text.length > 1_000_000) throw new Error('The native message is too large.')
		return text
	}
	private reasoning(message: NativeMessage, index: number, block: Block): void {
		if (block.reasoningCompleted) return
		block.reasoningCompleted = true
		this.event({
			...this.turn,
			kind: 'reasoning',
			nativeItemId: message.id,
			blockId: `${message.id}:${index}`,
			status: 'completed',
			...(block.text ? { text: block.text } : {}),
		})
	}

	consume(frame: Record<string, unknown>): readonly HarnessEvent[] {
		this.events.length = 0
		if (this.finished) return []
		if (frame.type === 'stream_event') this.stream(claudeRecord(frame.event))
		else if (frame.type === 'assistant') this.assistant(frame)
		else if (frame.type === 'user') this.results(frame)
		else if (frame.type === 'result') this.finish(frame)
		return [...this.events]
	}
	private stream(event: Record<string, unknown> | undefined): void {
		if (!event) return
		if (event.type === 'message_start') {
			const id = claudeString(claudeRecord(event.message)?.id)
			const message = id ? this.message(id) : undefined
			if (!message || message.completed || message.streamed) return
			message.streamed = true
			this.currentMessage = message
			return
		}
		const message = this.currentMessage
		if (!message || message.completed) return
		if (event.type === 'message_delta') {
			const reason = messageReason(claudeRecord(event.delta)?.stop_reason)
			if (reason) message.stopReason = reason
			return
		}
		if (event.type === 'message_stop') {
			const hasTool = [...message.blocks.values()].some((block) =>
				['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(block.type),
			)
			this.complete(
				message,
				this.text(message),
				message.stopReason ?? (hasTool ? 'tool_use' : 'end_turn'),
			)
			this.currentMessage = undefined
			return
		}
		const index = event.index
		if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 10_000) return
		if (event.type === 'content_block_start') {
			const raw = claudeRecord(event.content_block)
			if (!raw) return
			if (message.blocks.has(index as number)) return
			message.activeBlock = index as number
			const type = String(raw.type)
			const block: Block = {
				type,
				text: '',
				partialJson: '',
				completed: false,
			}
			if (type === 'text') block.text = typeof raw.text === 'string' ? raw.text : ''
			if (type === 'thinking') block.text = typeof raw.thinking === 'string' ? raw.thinking : ''
			if (['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(type)) {
				block.id = claudeString(raw.id)
				block.name = claudeString(raw.name)
				block.input = claudeJson(raw.input ?? {})
			}
			message.blocks.set(index as number, block)
			if (type === 'thinking')
				this.event({
					...this.turn,
					kind: 'reasoning',
					nativeItemId: message.id,
					blockId: `${message.id}:${index}`,
					status: 'pending',
					...(block.text ? { text: block.text } : {}),
				})
			if (type === 'text' && block.text)
				this.event({
					...this.turn,
					kind: 'text-delta',
					nativeItemId: message.id,
					text: block.text,
					part: { id: String(index) },
				})
			return
		}
		const block = message.blocks.get(index as number)
		if (!block || block.completed) return
		if (event.type === 'content_block_delta') {
			if (block.authoritative) return
			const delta = claudeRecord(event.delta)
			if (block.type === 'text' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
				block.text += delta.text
				this.event({
					...this.turn,
					kind: 'text-delta',
					nativeItemId: message.id,
					text: delta.text,
					part: { id: String(index) },
				})
			} else if (
				block.type === 'thinking' &&
				delta?.type === 'thinking_delta' &&
				typeof delta.thinking === 'string'
			) {
				block.text += delta.thinking
				this.event({
					...this.turn,
					kind: 'reasoning',
					nativeItemId: message.id,
					blockId: `${message.id}:${index}`,
					status: 'pending',
					text: delta.thinking,
				})
			} else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
				block.partialJson += delta.partial_json
			}
			if (block.text.length > 1_000_000 || block.partialJson.length > 1_000_000)
				throw new Error('The native message is too large.')
		} else if (event.type === 'content_block_stop') {
			block.completed = true
			if (block.type === 'thinking') this.reasoning(message, index as number, block)
			// Completed AssistantMessage blocks supply authoritative tool inputs.
			// Permission callbacks can arrive separately before that block.
		}
	}
	private assistant(frame: Record<string, unknown>): void {
		if (frame.error === 'authentication_failed') this.authenticationFailed = true
		// Error assistants carry remote diagnostics rather than authored output.
		if (typeof frame.error === 'string' && frame.error.length > 0) return
		const raw = claudeRecord(frame.message)
		const id = claudeString(raw?.id)
		if (!id || !raw || !Array.isArray(raw.content)) return
		const message = this.message(id)
		if (!message || message.completed) return
		const snapshotId = claudeString(frame.uuid)
		for (const [index, value] of raw.content.entries()) {
			const rawBlock = claudeRecord(value)
			if (!rawBlock) continue
			const type = String(rawBlock.type)
			if (!['text', 'thinking', 'tool_use', 'server_tool_use', 'mcp_tool_use'].includes(type))
				continue // Replay signatures and redacted blocks remain outside public output.
			// Claude emits each completed content block as a separate AssistantMessage
			// sharing message.id, immediately before that block's content_block_stop.
			const blockIndex =
				raw.content.length === 1
					? ((snapshotId ? message.snapshotBlocks.get(snapshotId) : undefined) ??
						(message.streamed ? message.activeBlock : undefined) ??
						(!snapshotId && messageReason(raw.stop_reason) ? 0 : message.blocks.size))
					: index
			if (blockIndex > 10_000 || message.snapshotBlocks.size > 10_000)
				throw new Error('The native message is too large.')
			if (snapshotId && raw.content.length === 1) message.snapshotBlocks.set(snapshotId, blockIndex)
			const prior = message.blocks.get(blockIndex)
			if (prior?.authoritative) continue
			const block: Block = {
				type,
				text:
					type === 'text' && typeof rawBlock.text === 'string'
						? rawBlock.text
						: type === 'thinking' && typeof rawBlock.thinking === 'string'
							? rawBlock.thinking
							: '',
				partialJson: '',
				completed: prior?.completed ?? false,
				authoritative: true,
				...(prior?.reasoningCompleted ? { reasoningCompleted: true } : {}),
			}
			if (block.text.length > 1_000_000) throw new Error('The native message is too large.')
			if (['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(type)) {
				block.id = claudeString(rawBlock.id)
				block.name = claudeString(rawBlock.name)
				block.input = claudeJson(rawBlock.input ?? {})
				this.tool(block)
			}
			message.blocks.set(blockIndex, block)
			if (type === 'thinking') this.reasoning(message, blockIndex, block)
		}
		this.text(message)
		const reason = messageReason(raw.stop_reason)
		if (reason) message.stopReason = reason
		// A completed block is not a completed message. The partial stream's
		// message_stop owns completion. UUID-bearing AssistantMessages can still be
		// separate blocks when each repeats stop_reason and partial events are absent.
		// Legacy UUID-less explicit full snapshots retain their completion boundary.
		if (!message.streamed && !snapshotId && reason)
			this.complete(message, this.text(message), reason)
	}
	private results(frame: Record<string, unknown>): void {
		const content = claudeRecord(frame.message)?.content
		if (!Array.isArray(content)) return
		for (const value of content) {
			const block = claudeRecord(value)
			if (block?.type !== 'tool_result') continue
			const id = claudeString(block.tool_use_id)
			const tool = id ? this.tools.get(id) : undefined
			if (!id || !tool || tool.completed) continue
			tool.completed = true
			let result =
				typeof block.content === 'string'
					? block.content
					: Array.isArray(block.content)
						? block.content
								.map((part) => claudeRecord(part))
								.filter((part) => part?.type === 'text')
								.map((part) => (typeof part?.text === 'string' ? part.text : ''))
								.join('\n')
						: ''
			result = result.slice(0, 1_000_000)
			this.event({
				...this.turn,
				kind: 'tool-completed',
				nativeItemId: id,
				name: tool.name,
				result,
				status: block.is_error === true ? 'failed' : 'completed',
			})
		}
	}
	private finish(frame: Record<string, unknown>): void {
		this.finished = true
		const cancelled =
			frame.terminal_reason === 'aborted_tools' ||
			frame.terminal_reason === 'aborted_streaming' ||
			frame.subtype === 'error_interrupted'
		const failed = frame.is_error === true || frame.subtype !== 'success'
		const status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed'
		for (const message of this.messages.values()) {
			if (!message.completed)
				this.complete(
					message,
					this.text(message),
					cancelled || failed ? 'cancelled' : (message.stopReason ?? 'end_turn'),
				)
		}
		// Terminal flushing can complete an earlier block-only message after a
		// later legacy full snapshot. Preserve authored order for final identity.
		for (const message of this.messages.values()) {
			if (message.completed) this.latestItem = message.id
		}
		for (const [id, tool] of this.tools) {
			if (!tool.completed)
				this.event({
					...this.turn,
					kind: 'tool-completed',
					nativeItemId: id,
					name: tool.name,
					result: '',
					status: cancelled ? 'cancelled' : 'failed',
				})
		}
		// Some successful turns expose only the result frame. Its actual native UUID
		// gives the SDK a durable message identity without inventing an assistant ID.
		if (status === 'completed' && !this.latestItem && typeof frame.result === 'string') {
			const id = claudeString(frame.uuid)
			const message = id ? this.message(id) : undefined
			if (message) this.complete(message, frame.result.slice(0, 1_000_000), 'end_turn')
		}
		const auth =
			this.authenticationFailed || frame.api_error_status === 401 || frame.api_error_status === 403
		this.event({
			...this.turn,
			kind: 'turn-completed',
			status,
			...(this.latestItem ? { finalItemId: this.latestItem } : {}),
			...(!failed && typeof frame.result === 'string'
				? { result: frame.result.slice(0, 1_000_000) }
				: {}),
			...(status === 'failed'
				? {
						error: auth
							? {
									code: 'authentication-required',
									message:
										'The native engine cannot use its current sign-in. Check its sign-in or choose another engine.',
								}
							: {
									code: 'native-turn-failed',
									message: 'The native engine could not complete this turn.',
								},
					}
				: {}),
		})
	}
}
