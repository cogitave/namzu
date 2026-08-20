import {
	type Message,
	isCompactionMessage,
	isProjectInstructionMessageSource,
	isWorkingMemoryMessage,
} from '@namzu/sdk'

export type PriorMessagesResult =
	| { readonly ok: true; readonly messages: readonly Message[] }
	| { readonly ok: false; readonly error: string }

type JSONObject = Record<string, unknown>

const isObject = (value: unknown): value is JSONObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value)

function optional(
	value: JSONObject,
	key: string,
	path: string,
	accepts: (candidate: unknown) => boolean,
	expected: string,
): string | null {
	const candidate = value[key]
	return candidate === undefined || accepts(candidate) ? null : `${path}.${key} must be ${expected}`
}

function stringField(value: JSONObject, key: string, path: string): string | null {
	return typeof value[key] === 'string' ? null : `${path}.${key} must be a string`
}

function validateCommon(value: JSONObject, path: string): string | null {
	return (
		optional(value, 'timestamp', path, isFiniteNumber, 'a finite number') ??
		optional(
			value,
			'cacheHint',
			path,
			(candidate) => candidate === 'cache' || candidate === 'ephemeral' || candidate === 'none',
			'"cache", "ephemeral", or "none"',
		) ??
		optional(value, 'retain', path, (candidate) => typeof candidate === 'boolean', 'a boolean')
	)
}

function validateAttachment(value: unknown, path: string): string | null {
	if (!isObject(value)) return `${path} must be an attachment object`
	const type = value.type
	if (type === 'stored') {
		return `${path} is a stored attachment reference, but stateless run-stream has no attachment store; send inline data instead`
	}
	if (type === 'document') {
		return (
			stringField(value, 'data', path) ??
			stringField(value, 'mediaType', path) ??
			optional(value, 'name', path, (candidate) => typeof candidate === 'string', 'a string') ??
			optional(value, 'citations', path, (candidate) => typeof candidate === 'boolean', 'a boolean')
		)
	}
	if (type !== undefined && type !== 'image') {
		return `${path}.type must be "image", "document", "stored", or absent`
	}
	return stringField(value, 'data', path) ?? stringField(value, 'mediaType', path)
}

function validateAttachments(value: unknown, path: string): string | null {
	if (!Array.isArray(value)) return `${path} must be an array`
	for (let index = 0; index < value.length; index++) {
		const error = validateAttachment(value[index], `${path}[${index}]`)
		if (error) return error
	}
	return null
}

function validateUserSource(value: unknown, path: string): string | null {
	if (!isObject(value)) return `${path} must be a source object`
	if (value.type === 'project-instructions') {
		return isProjectInstructionMessageSource(value)
			? null
			: `${path} must contain unique canonical project-relative AGENTS.md paths`
	}
	if (value.type !== 'goal-round') {
		return `${path}.type must be "goal-round" or "project-instructions"`
	}
	return (
		stringField(value, 'goalId', path) ??
		stringField(value, 'objective', path) ??
		(isFiniteNumber(value.goalRevision) ? null : `${path}.goalRevision must be a finite number`) ??
		(isFiniteNumber(value.round) ? null : `${path}.round must be a finite number`) ??
		(isFiniteNumber(value.maxGoalRounds) ? null : `${path}.maxGoalRounds must be a finite number`)
	)
}

function validateAssistantSource(value: unknown, path: string): string | null {
	if (!isObject(value)) return `${path} must be a source object`
	if (value.type !== 'model') return `${path}.type must be "model"`
	return (
		stringField(value, 'providerId', path) ??
		stringField(value, 'model', path) ??
		(Number.isSafeInteger(value.chainIndex) && (value.chainIndex as number) >= 0
			? null
			: `${path}.chainIndex must be a non-negative safe integer`)
	)
}

function validateToolCall(value: unknown, path: string): string | null {
	if (!isObject(value)) return `${path} must be a tool-call object`
	const fn = value.function
	if (!isObject(fn)) return `${path}.function must be an object`
	const metadata = value.metadata
	return (
		stringField(value, 'id', path) ??
		(value.type === 'function' ? null : `${path}.type must be "function"`) ??
		stringField(fn, 'name', `${path}.function`) ??
		stringField(fn, 'arguments', `${path}.function`) ??
		(metadata === undefined
			? null
			: !isObject(metadata)
				? `${path}.metadata must be an object`
				: (optional(
						metadata,
						'inputTruncated',
						`${path}.metadata`,
						(candidate) => typeof candidate === 'boolean',
						'a boolean',
					) ??
					optional(
						metadata,
						'partialArguments',
						`${path}.metadata`,
						(candidate) => typeof candidate === 'string',
						'a string',
					)))
	)
}

function validateReasoning(value: unknown, path: string): string | null {
	if (!isObject(value)) return `${path} must be a reasoning object`
	return (
		(value.type === 'thinking' || value.type === 'redacted_thinking'
			? null
			: `${path}.type must be "thinking" or "redacted_thinking"`) ??
		optional(value, 'text', path, (candidate) => typeof candidate === 'string', 'a string') ??
		optional(value, 'signature', path, (candidate) => typeof candidate === 'string', 'a string') ??
		optional(value, 'encrypted', path, (candidate) => typeof candidate === 'string', 'a string')
	)
}

function validateCitation(value: unknown, path: string): string | null {
	if (!isObject(value)) return `${path} must be a citation object`
	const location = value.location
	if (!isObject(location)) return `${path}.location must be an object`
	return (
		stringField(value, 'citedText', path) ??
		(isFiniteNumber(value.documentIndex)
			? null
			: `${path}.documentIndex must be a finite number`) ??
		optional(
			value,
			'documentTitle',
			path,
			(candidate) => typeof candidate === 'string',
			'a string',
		) ??
		(location.kind === 'page' || location.kind === 'char' || location.kind === 'block'
			? null
			: `${path}.location.kind must be "page", "char", or "block"`) ??
		(isFiniteNumber(location.start) ? null : `${path}.location.start must be a finite number`) ??
		(isFiniteNumber(location.end) ? null : `${path}.location.end must be a finite number`)
	)
}

function validateToolResultBlock(value: unknown, path: string): string | null {
	if (!isObject(value)) return `${path} must be a tool-result block object`
	if (value.type === 'text') return stringField(value, 'text', path)
	if (value.type === 'image') {
		return stringField(value, 'data', path) ?? stringField(value, 'mediaType', path)
	}
	if (value.type === 'document') return validateAttachment(value, path)
	return `${path}.type must be "text", "image", or "document"`
}

function validateMessage(value: unknown, index: number): string | null {
	const path = `messages[${index}]`
	if (!isObject(value)) return `${path} must be an object`
	const common = validateCommon(value, path)
	if (common) return common

	if (value.role === 'system') {
		if (typeof value.content !== 'string') return `${path}.content must be a string`
		return isCompactionMessage(value.content) || isWorkingMemoryMessage(value.content)
			? null
			: `${path} is an arbitrary system prompt; stateless history accepts only compacted or working-memory conversation state`
	}
	if (value.role === 'user') {
		if (typeof value.content !== 'string') return `${path}.content must be a string`
		return (
			(value.attachments === undefined
				? null
				: validateAttachments(value.attachments, `${path}.attachments`)) ??
			(value.source === undefined ? null : validateUserSource(value.source, `${path}.source`))
		)
	}
	if (value.role === 'assistant') {
		if (typeof value.content !== 'string' && value.content !== null) {
			return `${path}.content must be a string or null`
		}
		if (value.toolCalls !== undefined) {
			if (!Array.isArray(value.toolCalls)) return `${path}.toolCalls must be an array`
			for (let callIndex = 0; callIndex < value.toolCalls.length; callIndex++) {
				const error = validateToolCall(
					value.toolCalls[callIndex],
					`${path}.toolCalls[${callIndex}]`,
				)
				if (error) return error
			}
		}
		if (value.reasoning !== undefined) {
			if (!Array.isArray(value.reasoning)) return `${path}.reasoning must be an array`
			for (let reasoningIndex = 0; reasoningIndex < value.reasoning.length; reasoningIndex++) {
				const error = validateReasoning(
					value.reasoning[reasoningIndex],
					`${path}.reasoning[${reasoningIndex}]`,
				)
				if (error) return error
			}
		}
		if (value.citations !== undefined) {
			if (!Array.isArray(value.citations)) return `${path}.citations must be an array`
			for (let citationIndex = 0; citationIndex < value.citations.length; citationIndex++) {
				const error = validateCitation(
					value.citations[citationIndex],
					`${path}.citations[${citationIndex}]`,
				)
				if (error) return error
			}
		}
		return value.source === undefined
			? null
			: validateAssistantSource(value.source, `${path}.source`)
	}
	if (value.role === 'tool') {
		if (typeof value.content !== 'string') {
			if (!Array.isArray(value.content)) {
				return `${path}.content must be a string or tool-result block array`
			}
			for (let blockIndex = 0; blockIndex < value.content.length; blockIndex++) {
				const error = validateToolResultBlock(
					value.content[blockIndex],
					`${path}.content[${blockIndex}]`,
				)
				if (error) return error
			}
		}
		return (
			stringField(value, 'toolCallId', path) ??
			optional(value, 'isError', path, (candidate) => typeof candidate === 'boolean', 'a boolean')
		)
	}
	return `${path}.role must be "system", "user", "assistant", or "tool"`
}

function validateSequence(messages: readonly Message[]): string | null {
	const seenCallIds = new Set<string>()
	let pending: { readonly openedAt: number; readonly ids: Set<string> } | null = null
	let sawConversation = false

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (!message) continue

		if (pending) {
			if (message.role !== 'tool') {
				return `messages[${index}] cannot appear before every tool call from messages[${pending.openedAt}] has a result`
			}
			if (!pending.ids.has(message.toolCallId)) {
				return `messages[${index}].toolCallId does not match an unanswered call from messages[${pending.openedAt}]`
			}
			pending.ids.delete(message.toolCallId)
			if (pending.ids.size === 0) pending = null
			continue
		}

		if (message.role === 'system') {
			if (sawConversation) return `messages[${index}] is a system message after conversation began`
			continue
		}
		if (!sawConversation) {
			sawConversation = true
			if (message.role !== 'user') {
				return `messages[${index}] must be a user message at the start of conversation history`
			}
		}
		if (message.role === 'tool') return `messages[${index}] is a tool result with no pending call`
		if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
			continue
		}

		const ids = new Set<string>()
		for (let callIndex = 0; callIndex < message.toolCalls.length; callIndex++) {
			const id = message.toolCalls[callIndex]?.id
			if (!id) continue
			if (seenCallIds.has(id) || ids.has(id)) {
				return `messages[${index}].toolCalls[${callIndex}].id duplicates tool call id "${id}"`
			}
			ids.add(id)
			seenCallIds.add(id)
		}
		pending = { openedAt: index, ids }
	}

	if (pending) {
		return `messages[${pending.openedAt}] has tool calls without immediate results for: ${[...pending.ids].join(', ')}`
	}
	return null
}

/** Parse the stateless stdin contract without dropping or inventing message fields. */
export function parsePriorMessages(raw: string): PriorMessagesResult {
	const trimmed = raw.trim()
	if (!trimmed) return { ok: true, messages: [] }

	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch {
		return { ok: false, error: 'stdin history is not valid JSON' }
	}
	if (!Array.isArray(parsed)) {
		return { ok: false, error: 'stdin history must be a JSON Message[] array' }
	}
	for (let index = 0; index < parsed.length; index++) {
		const error = validateMessage(parsed[index], index)
		if (error) return { ok: false, error }
	}
	const messages = parsed as Message[]
	const sequenceError = validateSequence(messages)
	return sequenceError ? { ok: false, error: sequenceError } : { ok: true, messages }
}
