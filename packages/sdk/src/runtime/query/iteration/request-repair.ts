import { createHash } from 'node:crypto'

import { repairToolMessageHistory, toolHistoryRepairChanged } from '../../../compaction/dangling.js'
import { isProviderRequestError } from '../../../provider/errors.js'
import { isImageInputRefusal } from '../../../provider/image-input-refusal.js'
import type { Message } from '../../../types/message/index.js'
import type {
	AssistantMessage,
	MessageAttachment,
	ToolResultBlock,
} from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import { findSingleRequestImage } from '../request-rich-content.js'
import { isProviderRejectedImageError } from './provider-rejected-image.js'

/**
 * Repair-and-retry for a request a provider rejects as invalid (a 400 that is
 * not a context overflow), so a conversation does not dead-end on it.
 *
 * Mirrors the reference terminal's table of silent 400 recoveries: pair tool
 * calls with results before every send, strip rejected reasoning, latch off a
 * parameter the model refuses, and take rejected media out of the OUTGOING
 * request. Stored history is never edited; the same edits are derived again on
 * every later send (the reference calls this derive-on-send healing).
 *
 * It is one decorator over `provider.chatStream`, so a rejection is only
 * acted on when nothing has been accepted yet: resending then cannot
 * duplicate output.
 */

export type RejectedParameter = 'effort' | 'thinking' | 'temperature' | 'topP' | 'responseFormat'

export type MediaRemoval = {
	readonly count: number
	readonly kind: 'image' | 'document' | 'media'
}

export interface RequestRepairHooks {
	/** Debug-level record of a silent repair. Never shown to the person. */
	readonly debug?: (message: string, data?: Record<string, unknown>) => void
	/** Media was taken out of a request that then went through. Called once per removal. */
	readonly onMediaRemoved?: (removal: MediaRemoval) => void | Promise<void>
}

type Rejection =
	| { readonly kind: 'tool-pairing' }
	| { readonly kind: 'reasoning' }
	| {
			readonly kind: 'parameter'
			readonly parameters: readonly RejectedParameter[]
	  }
	| {
			readonly kind: 'media'
			readonly messageIndex?: number
			readonly generic: boolean
	  }

const MAX_REPAIRS_PER_REQUEST = 8
const MAX_STRIPS_PER_INDEX = 3
/** The reference drops media in these steps for an unprocessable request. */
const GENERIC_MEDIA_LIMITS: readonly number[] = [510, 255, 127]

const REFUSAL_WORDS =
	/\b(?:unsupported|not\s+supported|does\s?n[o']t\s+support|do\s+not\s+support|unknown|unrecognized|not\s+allowed|not\s+available|invalid|cannot|can['’]t|deprecated|only\s+the\s+default)\b/i

const PARAMETER_CODES: ReadonlySet<string> = new Set([
	'unsupported_parameter',
	'unsupported_value',
	'unknown_parameter',
])

const REASONING_CODES: ReadonlySet<string> = new Set([
	'invalid_encrypted_content',
	'invalid_reasoning',
	'invalid_signature',
])

const TOOL_PAIRING =
	/\btool_use\b.{0,120}\btool_result\b|\btool_result\b.{0,120}\btool_use\b|unexpected\s+`?tool_use_id`?|tool_use\s+ids?\s+must\s+be\s+unique|\btool_call_id\b|role\s+'tool'\s+must\s+be\s+a\s+response|'tool_calls'\s+must\s+be\s+followed|Expected\s+toolResult\s+blocks|function\s+call\s+turn\s+comes\s+immediately|number\s+of\s+function\s+response\s+parts/i

const REASONING =
	/\bthought[_ ]?signature\b|`?signature`?\s+in\s+`?(?:thinking|redacted_thinking)|\b(?:thinking|redacted_thinking)\s+blocks?\b.{0,160}\b(?:cannot|can['’]t|must|invalid|modified|expected)|\bexpected\s+`?(?:thinking|redacted_thinking)`?|\bencrypted[_ ]content\b|\breasoning\s+item\b|\bitem\s+'rs_[^']*'|\bof\s+type\s+'reasoning'/i

const MEDIA_NOUN = /\b(?:image|images|document|documents|pdf|media|attachment|base64|picture)\b/i
const MEDIA_FAULT =
	/\b(?:too\s+(?:large|big|many)|exceed\w*|maximum|larger\s+than|limit|dimensions?|could\s+not\s+(?:be\s+)?(?:process|decode|load|read|fetch|download)\w*|cannot\s+(?:be\s+)?(?:process|decode|load|read)\w*|failed\s+to\s+(?:process|decode|load|read|download)|unsupported|not\s+supported|invalid|corrupt\w*|malformed|password|encrypted|page\s+limit)\b/i
const GENERIC_MEDIA =
	/\bunprocessable\b|\btoo\s+many\s+(?:images?|documents?|media|attachments?)\b|\bmedia_budget\b/i

function mediaIndex(text: string): number | undefined {
	const match =
		/\bmessages?[.[]\s*(\d+)\s*\]?[.[]\s*content\b/i.exec(text) ?? /\binput\[(\d+)\]/i.exec(text)
	return match?.[1] !== undefined ? Number(match[1]) : undefined
}

function rejectedParameters(
	text: string,
	code: string | undefined,
	params: ChatCompletionParams,
): RejectedParameter[] {
	const refused = (code !== undefined && PARAMETER_CODES.has(code)) || REFUSAL_WORDS.test(text)
	if (!refused) return []
	const found: RejectedParameter[] = []
	if (params.effort !== undefined && /\b(?:reasoning[_. -]?effort|effort)\b/i.test(text)) {
		found.push('effort')
	}
	if (params.thinking !== undefined && /\bthinking\b/i.test(text)) found.push('thinking')
	if (params.temperature !== undefined && /\btemperature\b/i.test(text)) found.push('temperature')
	if (params.topP !== undefined && /\btop[_ ]?p\b/i.test(text)) found.push('topP')
	if (
		params.responseFormat !== undefined &&
		/\bresponse_format\b|\boutput_config\b|\bjson_schema\b|\bjson_object\b|structured\s+output/i.test(
			text,
		)
	) {
		found.push('responseFormat')
	}
	// Providers that say two are incompatible name both; either one resolves it.
	if (found.includes('temperature') && params.topP !== undefined && /\btop[_ ]?p\b/i.test(text)) {
		if (!found.includes('topP')) found.push('topP')
	}
	return found
}

/**
 * What kind of invalid request this is, from the provider's structured code
 * where it sent one and from its wording only as a fallback.
 */
export function classifyRequestRejection(
	error: unknown,
	params: ChatCompletionParams,
): Rejection | null {
	if (!isProviderRequestError(error) || error.kind !== 'bad_request') return null
	if (
		error.status !== undefined &&
		error.status !== 400 &&
		error.status !== 413 &&
		error.status !== 422
	) {
		return null
	}
	const text = error.detail ?? error.message
	const code = error.providerCode

	if (code !== undefined && REASONING_CODES.has(code)) return { kind: 'reasoning' }
	if (REASONING.test(text)) return { kind: 'reasoning' }
	if (TOOL_PAIRING.test(text)) return { kind: 'tool-pairing' }

	const parameters = rejectedParameters(text, code, params)
	if (parameters.length > 0) return { kind: 'parameter', parameters }

	if (code === 'invalid_image')
		return { kind: 'media', generic: false, messageIndex: mediaIndex(text) }
	if (GENERIC_MEDIA.test(text) || error.status === 413 || error.status === 422) {
		return { kind: 'media', generic: true }
	}
	if (MEDIA_NOUN.test(text) && MEDIA_FAULT.test(text)) {
		const messageIndex = mediaIndex(text)
		return {
			kind: 'media',
			generic: false,
			...(messageIndex !== undefined ? { messageIndex } : {}),
		}
	}
	return null
}

function isAccepted(chunk: StreamChunk): boolean {
	if (chunk.retry !== undefined || chunk.fallback !== undefined || chunk.error !== undefined) {
		return false
	}
	return Boolean(
		chunk.delta.content ||
			chunk.delta.toolCalls?.length ||
			chunk.delta.toolCallEnd ||
			chunk.delta.reasoning ||
			chunk.delta.citation ||
			chunk.finishReason !== undefined ||
			chunk.usage !== undefined ||
			chunk.replayState !== undefined ||
			chunk.textParts !== undefined,
	)
}

const mediaFingerprint = (data: string, mediaType: string): string =>
	createHash('sha256').update(mediaType).update('\0').update(data).digest('hex')

const REMOVED_NOTE =
	'the provider could not process it. The file may be unsupported or corrupt; do not retry reading it. If you need to inspect it, use a shell command instead.'
const removedNote = (kind: 'image' | 'document'): string => `[${kind} removed: ${REMOVED_NOTE}]`

interface MediaSlot {
	readonly messageIndex: number
	readonly itemIndex: number
	readonly source: 'user' | 'tool'
	readonly kind: 'image' | 'document'
	readonly fingerprint: string
}

function listMedia(messages: readonly Message[]): MediaSlot[] {
	const slots: MediaSlot[] = []
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === 'user') {
			for (const [itemIndex, attachment] of (message.attachments ?? []).entries()) {
				if (attachment.type === 'stored') continue
				slots.push({
					messageIndex,
					itemIndex,
					source: 'user',
					kind: attachment.type === 'document' ? 'document' : 'image',
					fingerprint: mediaFingerprint(attachment.data, attachment.mediaType),
				})
			}
		} else if (message.role === 'tool' && Array.isArray(message.content)) {
			for (const [itemIndex, block] of message.content.entries()) {
				if (block.type !== 'image' && block.type !== 'document') continue
				slots.push({
					messageIndex,
					itemIndex,
					source: 'tool',
					kind: block.type,
					fingerprint: mediaFingerprint(block.data, block.mediaType),
				})
			}
		}
	}
	return slots
}

/** Replace the given media with a short text note, in a copy. */
function removeMedia(messages: readonly Message[], slots: readonly MediaSlot[]): Message[] {
	if (slots.length === 0) return messages as Message[]
	const byMessage = new Map<number, Map<number, MediaSlot>>()
	for (const slot of slots) {
		const items = byMessage.get(slot.messageIndex) ?? new Map<number, MediaSlot>()
		items.set(slot.itemIndex, slot)
		byMessage.set(slot.messageIndex, items)
	}
	return messages.map((message, messageIndex) => {
		const items = byMessage.get(messageIndex)
		if (!items) return message
		if (message.role === 'user') {
			const attachments: readonly MessageAttachment[] = message.attachments ?? []
			const kept = attachments.filter((_a, i) => !items.has(i))
			const notes = [...items.values()]
				.sort((a, b) => a.itemIndex - b.itemIndex)
				.map((slot) => removedNote(slot.kind))
				.join('\n\n')
			const { attachments: _drop, ...rest } = message
			return {
				...rest,
				content: message.content.length > 0 ? `${message.content}\n\n${notes}` : notes,
				...(kept.length > 0 ? { attachments: kept } : {}),
			}
		}
		if (message.role === 'tool' && Array.isArray(message.content)) {
			const content: ToolResultBlock[] = message.content.map((block, i) => {
				const slot = items.get(i)
				return slot ? { type: 'text', text: removedNote(slot.kind) } : block
			})
			return { ...message, content }
		}
		return message
	})
}

function stripReasoning(messages: readonly Message[]): Message[] {
	let changed = false
	const out = messages.map((message) => {
		if (message.role !== 'assistant') return message
		const assistant = message as AssistantMessage
		const hasState =
			assistant.source !== undefined &&
			(assistant.source as { replayState?: unknown }).replayState !== undefined
		if (assistant.reasoning === undefined && !hasState) return message
		changed = true
		const { reasoning: _reasoning, source, ...rest } = assistant
		if (source === undefined) return rest as Message
		const { replayState: _state, ...route } = source as typeof source & {
			replayState?: unknown
		}
		return { ...rest, source: route } as Message
	})
	return changed ? out : (messages as Message[])
}

/**
 * Which outgoing message a provider's `messages.N` points at. The index counts
 * the provider's own wire array, which merges consecutive tool results and
 * leaves system turns out, so it is mapped back approximately; a miss falls
 * through to the newest-media rule.
 */
function carrierOfWireIndex(messages: readonly Message[], wireIndex: number): number | undefined {
	let wire = -1
	let previousWasTool = false
	for (const [index, message] of messages.entries()) {
		if (message.role === 'system') continue
		const merges = (message.role === 'tool' || message.role === 'user') && previousWasTool
		if (!merges) wire++
		previousWasTool = message.role === 'tool' || (message.role === 'user' && previousWasTool)
		if (wire === wireIndex && listMedia([message]).length > 0) return index
		if (wire > wireIndex) break
	}
	return undefined
}

export class RequestRepair {
	/** Parameters a route refused, for the rest of the run. */
	private readonly latched = new Map<string, Set<RejectedParameter>>()
	/** Routes whose history carries reasoning they cannot take back. */
	private readonly reasoningOff = new Set<string>()
	/** Media a provider rejected, matched again on every later send. */
	private readonly rejectedMedia = new Set<string>()
	/** Newest media a provider accepts, once a generic rejection taught it. */
	private mediaLimit: number | undefined

	constructor(private readonly hooks: RequestRepairHooks = {}) {}

	private routeKey(provider: Pick<LLMProvider, 'id'>, params: ChatCompletionParams): string {
		return `${params.providerRoute?.providerId ?? provider.id}|${params.providerRoute?.model ?? params.model}`
	}

	/** Everything already learned, then the tool pairing the provider requires. */
	private prepare(
		provider: Pick<LLMProvider, 'id'>,
		params: ChatCompletionParams,
	): ChatCompletionParams {
		const key = this.routeKey(provider, params)
		let next: ChatCompletionParams = params

		const latched = this.latched.get(key)
		if (latched) next = withoutParameters(next, latched)

		let messages = next.messages
		if (this.reasoningOff.has(key)) messages = stripReasoning(messages)
		messages = this.applyMediaMemory(messages)
		messages = this.pair(messages)
		return messages === next.messages ? next : { ...next, messages }
	}

	private applyMediaMemory(messages: Message[]): Message[] {
		if (this.rejectedMedia.size === 0 && this.mediaLimit === undefined) return messages
		const slots = listMedia(messages)
		const drop = slots.filter((slot) => this.rejectedMedia.has(slot.fingerprint))
		const rest = slots.filter((slot) => !this.rejectedMedia.has(slot.fingerprint))
		if (this.mediaLimit !== undefined && rest.length > this.mediaLimit) {
			drop.push(...rest.slice(0, rest.length - this.mediaLimit))
		}
		return removeMedia(messages, drop)
	}

	/** The shared tool-history repair, on the outgoing copy. Duplicate call ids fail closed there, so the request goes out as it is. */
	private pair(messages: Message[]): Message[] {
		try {
			const repaired = repairToolMessageHistory(messages)
			if (!toolHistoryRepairChanged(repaired.report)) return messages
			this.hooks.debug?.('Repaired tool pairing before sending', {
				...repaired.report,
			})
			return repaired.messages
		} catch (error) {
			this.hooks.debug?.('Tool pairing could not be repaired before sending', {
				error: error instanceof Error ? error.message : String(error),
			})
			return messages
		}
	}

	/** The request to send after `rejection`, or null when nothing more can be tried. */
	private next(
		provider: Pick<LLMProvider, 'id'>,
		params: ChatCompletionParams,
		rejection: Rejection,
		spent: Set<string>,
		stripsByIndex: Map<number, number>,
	): { params: ChatCompletionParams; removal?: MediaRemoval } | null {
		const key = this.routeKey(provider, params)
		switch (rejection.kind) {
			case 'tool-pairing': {
				if (spent.has('tool-pairing')) return null
				spent.add('tool-pairing')
				const repaired = repairOnce(params.messages)
				if (repaired === null) return null
				this.hooks.debug?.('Retrying after a tool-history rejection', {
					route: key,
				})
				return { params: { ...params, messages: repaired } }
			}
			case 'reasoning': {
				if (spent.has('reasoning')) return null
				spent.add('reasoning')
				const messages = stripReasoning(params.messages)
				if (messages === params.messages) return null
				this.reasoningOff.add(key)
				this.hooks.debug?.('Retrying without reasoning blocks', { route: key })
				return { params: { ...params, messages } }
			}
			case 'parameter': {
				const fresh = rejection.parameters.filter((name) => !spent.has(`param:${name}`))
				if (fresh.length === 0) return null
				for (const name of fresh) spent.add(`param:${name}`)
				const set = this.latched.get(key) ?? new Set<RejectedParameter>()
				for (const name of fresh) set.add(name)
				this.latched.set(key, set)
				this.hooks.debug?.('Retrying without parameters the model refused', {
					route: key,
					parameters: fresh,
				})
				return { params: withoutParameters(params, new Set(fresh)) }
			}
			case 'media':
				return this.nextWithoutMedia(params, rejection, spent, stripsByIndex)
		}
	}

	private nextWithoutMedia(
		params: ChatCompletionParams,
		rejection: Extract<Rejection, { kind: 'media' }>,
		spent: Set<string>,
		stripsByIndex: Map<number, number>,
	): { params: ChatCompletionParams; removal?: MediaRemoval } | null {
		const slots = listMedia(params.messages)
		if (slots.length === 0) return null

		let victims: MediaSlot[] = []
		if (!rejection.generic) {
			if (rejection.messageIndex !== undefined) {
				const carrier = carrierOfWireIndex(params.messages, rejection.messageIndex)
				const used = stripsByIndex.get(rejection.messageIndex) ?? 0
				if (carrier !== undefined && used < MAX_STRIPS_PER_INDEX) {
					stripsByIndex.set(rejection.messageIndex, used + 1)
					victims = slots.filter((slot) => slot.messageIndex === carrier)
				}
			}
			if (victims.length === 0) {
				// No usable index: the newest message that carries media.
				const newest = slots[slots.length - 1]
				if (newest === undefined) return null
				const count = (stripsByIndex.get(-1) ?? 0) + 1
				if (count > MAX_STRIPS_PER_INDEX) return null
				stripsByIndex.set(-1, count)
				victims = slots.filter((slot) => slot.messageIndex === newest.messageIndex)
			}
		} else {
			// The reference's steps, then halving for smaller requests, down to none:
			// each step keeps fewer than the request held, newest first.
			const limit =
				GENERIC_MEDIA_LIMITS.find((candidate) => candidate < slots.length) ??
				Math.floor(slots.length / 2)
			spent.add(`limit:${limit}`)
			this.mediaLimit = Math.min(this.mediaLimit ?? limit, limit)
			victims = slots.slice(0, slots.length - limit)
		}

		for (const slot of victims) this.rejectedMedia.add(slot.fingerprint)
		this.hooks.debug?.('Retrying without media the provider rejected', {
			count: victims.length,
		})
		const kinds = new Set(victims.map((slot) => slot.kind))
		return {
			params: { ...params, messages: removeMedia(params.messages, victims) },
			removal: {
				count: victims.length,
				kind: kinds.size === 1 ? ([...kinds][0] as 'image' | 'document') : 'media',
			},
		}
	}

	/**
	 * Send `params`, repairing and resending a request the provider rejects as
	 * invalid until it is accepted or nothing more can be changed. The original
	 * rejection is thrown when nothing applies, so the turn settles as before.
	 */
	async *stream(provider: LLMProvider, params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		let current = this.prepare(provider, params)
		const spent = new Set<string>()
		const stripsByIndex = new Map<number, number>()
		let removal: MediaRemoval | undefined
		let repairs = 0

		for (;;) {
			let produced = false
			let reported = false
			try {
				for await (const chunk of provider.chatStream(current)) {
					if (isAccepted(chunk)) {
						produced = true
						if (removal !== undefined && !reported) {
							reported = true
							await this.hooks.onMediaRemoved?.(removal)
						}
					}
					yield chunk
				}
				if (removal !== undefined && !reported) await this.hooks.onMediaRemoved?.(removal)
				return
			} catch (error) {
				if (current.signal?.aborted) throw current.signal.reason
				if (produced || repairs >= MAX_REPAIRS_PER_REQUEST) throw error
				if (isHandledElsewhere(error, current)) throw error
				const rejection = classifyRequestRejection(error, current)
				if (rejection === null) throw error
				const step = this.next(provider, current, rejection, spent, stripsByIndex)
				if (step === null) throw error
				repairs++
				current = step.params
				if (step.removal !== undefined) {
					removal = {
						count: (removal?.count ?? 0) + step.removal.count,
						kind: removal && removal.kind !== step.removal.kind ? 'media' : step.removal.kind,
					}
				}
			}
		}
	}
}

/** Re-run the shared repair on the outgoing copy; null when it changes nothing or cannot. */
function repairOnce(messages: Message[]): Message[] | null {
	try {
		const repaired = repairToolMessageHistory(messages)
		return toolHistoryRepairChanged(repaired.report) ? repaired.messages : null
	} catch {
		return null
	}
}

function withoutParameters(
	params: ChatCompletionParams,
	names: ReadonlySet<RejectedParameter>,
): ChatCompletionParams {
	if (names.size === 0) return params
	const next = { ...params }
	if (names.has('effort')) next.effort = undefined
	if (names.has('thinking')) next.thinking = undefined
	if (names.has('temperature')) next.temperature = undefined
	if (names.has('topP')) next.topP = undefined
	if (names.has('responseFormat')) next.responseFormat = undefined
	return next
}

/**
 * Rejections another recovery already owns: a model that reads text only, and
 * a single distinct image the provider calls invalid. Those keep their own
 * commit points in `provider-rejected-image.ts`, which wraps this one.
 */
function isHandledElsewhere(error: unknown, params: ChatCompletionParams): boolean {
	if (isImageInputRefusal(error)) return true
	return isProviderRejectedImageError(error) && findSingleRequestImage(params.messages) !== null
}
