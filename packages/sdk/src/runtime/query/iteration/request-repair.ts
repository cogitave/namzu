import { createHash } from 'node:crypto'

import { repairToolMessageHistory, toolHistoryRepairChanged } from '../../../compaction/dangling.js'
import { isProviderRequestError } from '../../../provider/errors.js'
import { isImageInputRefusal } from '../../../provider/image-input-refusal.js'
import type {
	AssistantMessage,
	Message,
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
 * The silent 400 recoveries, in order: pair tool
 * calls with results before a send, strip rejected reasoning, drop a
 * parameter the model refuses, and take rejected media out of the OUTGOING
 * request. Stored history is never edited.
 *
 * **Nothing is remembered on a guess.** Every repair is a guess about what the
 * provider objected to. What it teaches (a parameter to leave out, reasoning to
 * strip, media to omit, a media limit) is kept for the run only once a resend
 * WITHOUT the offending part was accepted. A guess that did not fix the
 * request is forgotten and the original rejection is thrown, so a wrong guess
 * never changes a later request.
 *
 * It decorates one model call of the agent loop (a turn, or the closing
 * summary), so a rejection is only acted on when nothing has been accepted yet:
 * resending then cannot duplicate output. Other callers of a provider, such as
 * compaction summaries, do not pass through it.
 */

export type RejectedParameter = 'effort' | 'thinking' | 'temperature' | 'topP' | 'responseFormat'

export interface MediaRemoval {
	readonly count: number
	readonly kind: 'image' | 'document' | 'media'
	/** Some of it was attached to the person's latest message. */
	readonly current: boolean
	/** It was dropped to fit a count the provider accepts, not because a file was faulty. */
	readonly limit: boolean
}

export interface RequestRepairHooks {
	/** Debug-level record of a silent repair. Never shown to the person. */
	readonly debug?: (message: string) => void
	/** Media was taken out of a request that then went through. Called once per removal. */
	readonly onMediaRemoved?: (removal: MediaRemoval) => void | Promise<void>
	/**
	 * The member that serves the next request. A fallback chain moves between
	 * members, and what a member refused is a fact about that member, not about
	 * the head of the chain.
	 */
	readonly servedBy?: () => { readonly providerId: string; readonly model?: string } | undefined
}

type Rejection =
	| { readonly kind: 'tool-pairing' }
	| { readonly kind: 'reasoning' }
	| { readonly kind: 'parameter'; readonly parameters: readonly RejectedParameter[] }
	| {
			readonly kind: 'media'
			readonly generic: boolean
			readonly messageIndex?: number
			readonly contentIndex?: number
	  }

/** Most repair resends for one original request, across every send it makes. */
export const MAX_REPAIRS_PER_REQUEST = 5
const MAX_STRIPS_PER_INDEX = 3
/** Media is dropped in these steps for an unprocessable request. */
const GENERIC_MEDIA_LIMITS: readonly number[] = [510, 255, 127]

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

/** A path into the tool list: wording about a tool schema is never about a request parameter or media. */
const TOOL_SCHEMA_PATH =
	/\b(?:tools?|functions?)[.[]\s*\d+|input_schema|\.properties\b|json\s+schema/i

const REFUSAL =
	"(?:unsupported|not\\s+supported|does\\s?n[o']t\\s+support|do\\s+not\\s+support|unrecognized|unknown\\s+(?:request\\s+)?(?:parameter|argument|field)|not\\s+allowed|deprecated|only\\s+the\\s+default)"

const PARAMETER_NAMES: Record<RejectedParameter, string> = {
	effort: '(?:reasoning[_. -]?effort|effort)',
	thinking: 'thinking',
	temperature: 'temperature',
	topP: 'top[_ ]?p',
	responseFormat:
		'(?:response_format|output_config(?:\\.format)?|json_schema|json_object|structured\\s+output)',
}

const PARAMETER_PATTERNS = Object.fromEntries(
	(Object.entries(PARAMETER_NAMES) as [RejectedParameter, string][]).map(([name, token]) => [
		name,
		{
			named: new RegExp(`\\b${token}\\b`, 'i'),
			refused: new RegExp(`${REFUSAL}.{0,80}\\b${token}\\b|\\b${token}\\b.{0,80}${REFUSAL}`, 'i'),
		},
	]),
) as Record<RejectedParameter, { named: RegExp; refused: RegExp }>

const BOTH_SAMPLING =
	/temperature.{0,60}top[_ ]?p.{0,80}(?:cannot|can['’]t|may\s+not|should\s+not).{0,20}(?:both|together)/i

const IMAGE_FAULT =
	/\b(?:images?|pictures?|photos?)\b.{0,100}\b(?:too\s+(?:large|big)|exceeds?|larger\s+than|maximum\s+(?:size|dimensions?)|dimensions?|(?:could|can)\s?not\s+be\s+(?:processed|decoded|loaded|read|fetched|downloaded)|failed\s+to\s+(?:process|decode|load|read|download)|unsupported|not\s+supported|corrupt\w*|malformed|truncated|invalid)\b|\b(?:(?:could|can)\s?not|failed\s+to|unable\s+to)\s+(?:process|decode|load|read|download|fetch)\b.{0,60}\b(?:images?|pictures?)\b|\bunsupported\s+(?:image|media)\b|\binvalid\s+image\b/i
const DOCUMENT_FAULT =
	/\bdocument_block\b|\b(?:documents?|pdfs?)\b.{0,80}\b(?:too\s+(?:large|big)|exceeds?\s+(?:the\s+)?(?:maximum|size|page)|page\s+limit|password|corrupt\w*|(?:could|can)\s?not\s+be\s+(?:processed|read|decoded)|failed\s+to\s+(?:process|read|decode))\b|\bpassword[- ]protected\s+pdf\b|\bpdf\b.{0,40}\bpages?\b.{0,20}\b(?:limit|maximum|exceeds?)\b/i
const GENERIC_MEDIA =
	/\bunprocessable\b.{0,100}\b(?:images?|media|documents?)\b|\b(?:images?|media|documents?)\b.{0,100}\bunprocessable\b|\btoo\s+many\s+(?:images?|documents?|media|attachments?)\b|\bmedia_budget\b|\bimage_block\b/i
const NAMES_MEDIA = /\b(?:images?|pictures?|photos?|documents?|pdfs?|media|attachments?)\b/i

function wireIndexes(text: string): { messageIndex?: number; contentIndex?: number } {
	const both = /\bmessages?[.[]\s*(\d+)\s*\]?[.[]\s*content[.[]\s*(\d+)/i.exec(text)
	if (both?.[1] !== undefined && both[2] !== undefined) {
		return { messageIndex: Number(both[1]), contentIndex: Number(both[2]) }
	}
	const only = /\bmessages?[.[]\s*(\d+)\b/i.exec(text)
	return only?.[1] !== undefined ? { messageIndex: Number(only[1]) } : {}
}

function rejectedParameters(
	text: string,
	code: string | undefined,
	params: ChatCompletionParams,
): RejectedParameter[] {
	if (TOOL_SCHEMA_PATH.test(text)) return []
	const structured = code !== undefined && PARAMETER_CODES.has(code)
	const set = {
		effort: params.effort !== undefined,
		thinking: params.thinking !== undefined,
		temperature: params.temperature !== undefined,
		topP: params.topP !== undefined,
		responseFormat: params.responseFormat !== undefined,
	} satisfies Record<RejectedParameter, boolean>
	const found: RejectedParameter[] = []
	for (const name of Object.keys(set) as RejectedParameter[]) {
		if (!set[name]) continue
		const pattern = PARAMETER_PATTERNS[name]
		if (structured ? pattern.named.test(text) : pattern.refused.test(text)) found.push(name)
	}
	if (found.length === 0 && set.topP && BOTH_SAMPLING.test(text)) found.push('topP')
	return found
}

function requestHasMedia(params: ChatCompletionParams): boolean {
	return listMedia(params.messages).length > 0
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

	if (TOOL_SCHEMA_PATH.test(text)) return null
	if (code === 'invalid_image') return { kind: 'media', generic: false, ...wireIndexes(text) }
	if (GENERIC_MEDIA.test(text)) return { kind: 'media', generic: true }
	// A bare 413 or 422 says nothing about media: it counts only when the
	// request carries some and the provider's words name it.
	if ((error.status === 413 || error.status === 422) && NAMES_MEDIA.test(text)) {
		return requestHasMedia(params) ? { kind: 'media', generic: true } : null
	}
	if (IMAGE_FAULT.test(text) || DOCUMENT_FAULT.test(text)) {
		return { kind: 'media', generic: false, ...wireIndexes(text) }
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

const FAULT_NOTE =
	'the provider could not process it. The file may be unsupported or corrupt; do not retry reading it. If you need to inspect it, use a shell command instead.'
const LIMIT_NOTE =
	'this conversation holds more files than the provider accepts at once, so the oldest are left out of the request. They are still in the conversation.'
const removedNote = (kind: 'image' | 'document', limit: boolean): string =>
	`[${kind} removed: ${limit ? LIMIT_NOTE : FAULT_NOTE}]`

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
function removeMedia(
	messages: readonly Message[],
	slots: readonly MediaSlot[],
	limit: boolean,
): Message[] {
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
				.map((slot) => removedNote(slot.kind, limit))
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
				return slot ? { type: 'text', text: removedNote(slot.kind, limit) } : block
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
 * The media a provider's `messages.N.content.M` points at, mapped back through
 * that driver's own serialisation. Exact for the two wires whose layout is
 * known; anything else returns undefined and the caller does not guess.
 *
 * - the content-block wire: system turns are left out; a run of consecutive tool results
 *   is ONE user entry whose blocks are those results; every other message,
 *   including a user turn that follows tool results, is its own entry; a user
 *   entry's blocks are its text (when not empty) and then each attachment.
 * - the chat-completions wire: one entry per message, system included; only user attachments
 *   travel as media (tool results are sent as text); blocks are the text (when
 *   not empty) and then each attachment.
 */
function mediaAtWireIndex(
	messages: readonly Message[],
	slots: readonly MediaSlot[],
	family: string,
	wireIndex: number,
	contentIndex: number | undefined,
): MediaSlot[] | undefined {
	if (family !== 'anthropic' && family !== 'openai') return undefined
	const entries: number[][] = []
	let inToolRun = false
	for (const [index, message] of messages.entries()) {
		if (family === 'anthropic') {
			if (message.role === 'system') continue
			if (message.role === 'tool') {
				if (!inToolRun) entries.push([])
				inToolRun = true
				entries[entries.length - 1]?.push(index)
				continue
			}
			inToolRun = false
		}
		entries.push([index])
	}
	const entry = entries[wireIndex]
	if (entry === undefined) return undefined
	const mine = slots.filter((slot) => entry.includes(slot.messageIndex))
	if (mine.length === 0) return undefined
	if (contentIndex === undefined) return mine
	const first = entry[0]
	const message = first === undefined ? undefined : messages[first]
	if (message?.role === 'user' && !(family === 'openai' && mine.some((s) => s.source === 'tool'))) {
		const itemIndex = contentIndex - (message.content.length > 0 ? 1 : 0)
		const hit = mine.filter((slot) => slot.itemIndex === itemIndex)
		return hit.length > 0 ? hit : mine
	}
	if (family === 'anthropic' && message?.role === 'tool') {
		const owner = entry[contentIndex]
		const hit = owner === undefined ? [] : mine.filter((slot) => slot.messageIndex === owner)
		return hit.length > 0 ? hit : mine
	}
	return mine
}

interface Learned {
	readonly latched: Map<string, Set<RejectedParameter>>
	readonly reasoningOff: Set<string>
	readonly rejectedMedia: Set<string>
	mediaLimit: number | undefined
}

const emptyLearned = (): Learned => ({
	latched: new Map(),
	reasoningOff: new Set(),
	rejectedMedia: new Set(),
	mediaLimit: undefined,
})

/** The budget and the unconfirmed guesses of one original request, shared by every send it makes. */
export interface RepairSession {
	readonly spent: Set<string>
	readonly stripsByIndex: Map<number, number>
	pending: Learned
	repairs: number
	removal: MediaRemoval | undefined
}

export class RequestRepair {
	private readonly learned: Learned = emptyLearned()

	constructor(private readonly hooks: RequestRepairHooks = {}) {}

	/** A fresh budget for one original request. */
	session(): RepairSession {
		return {
			spent: new Set(),
			stripsByIndex: new Map(),
			pending: emptyLearned(),
			repairs: 0,
			removal: undefined,
		}
	}

	private served(
		provider: Pick<LLMProvider, 'id'>,
		params: ChatCompletionParams,
	): { providerId: string; model: string } {
		const member = this.hooks.servedBy?.()
		return {
			providerId: member?.providerId ?? params.providerRoute?.providerId ?? provider.id,
			model: member?.model ?? params.providerRoute?.model ?? params.model,
		}
	}

	private routeKey(provider: Pick<LLMProvider, 'id'>, params: ChatCompletionParams): string {
		const { providerId, model } = this.served(provider, params)
		return `${providerId}|${model}`
	}

	/** Everything already confirmed, then the tool pairing the provider requires. */
	private prepare(
		provider: Pick<LLMProvider, 'id'>,
		params: ChatCompletionParams,
	): ChatCompletionParams {
		const key = this.routeKey(provider, params)
		let next: ChatCompletionParams = params

		const latched = this.learned.latched.get(key)
		if (latched) next = withoutParameters(next, latched)

		let messages = next.messages
		if (this.learned.reasoningOff.has(key)) messages = stripReasoning(messages)
		messages = this.applyMediaMemory(messages)
		messages = this.pair(messages)
		return messages === next.messages ? next : { ...next, messages }
	}

	private applyMediaMemory(messages: Message[]): Message[] {
		const { rejectedMedia, mediaLimit } = this.learned
		if (rejectedMedia.size === 0 && mediaLimit === undefined) return messages
		const slots = listMedia(messages)
		const faulty = slots.filter((slot) => rejectedMedia.has(slot.fingerprint))
		let out = removeMedia(messages, faulty, false)
		if (mediaLimit !== undefined) {
			const rest = listMedia(out)
			if (rest.length > mediaLimit) {
				out = removeMedia(out, rest.slice(0, rest.length - mediaLimit), true)
			}
		}
		return out
	}

	/** The shared tool-history repair, on the outgoing copy. Duplicate call ids fail closed there, so the request goes out as it is. */
	private pair(messages: Message[]): Message[] {
		try {
			const repaired = repairToolMessageHistory(messages)
			if (!toolHistoryRepairChanged(repaired.report)) return messages
			this.hooks.debug?.(`Repaired tool pairing before sending: ${JSON.stringify(repaired.report)}`)
			return repaired.messages
		} catch (error) {
			this.hooks.debug?.(
				`Tool pairing could not be repaired before sending: ${error instanceof Error ? error.message : String(error)}`,
			)
			return messages
		}
	}

	/** What a resend that was accepted has proved. */
	private commit(session: RepairSession): void {
		const { pending } = session
		for (const [key, names] of pending.latched) {
			const set = this.learned.latched.get(key) ?? new Set<RejectedParameter>()
			for (const name of names) set.add(name)
			this.learned.latched.set(key, set)
		}
		for (const key of pending.reasoningOff) this.learned.reasoningOff.add(key)
		for (const fingerprint of pending.rejectedMedia) this.learned.rejectedMedia.add(fingerprint)
		if (pending.mediaLimit !== undefined) {
			this.learned.mediaLimit = Math.min(
				this.learned.mediaLimit ?? pending.mediaLimit,
				pending.mediaLimit,
			)
		}
		session.pending = emptyLearned()
	}

	/** The request to send after `rejection`, or null when nothing more can be tried. */
	private next(
		provider: Pick<LLMProvider, 'id'>,
		params: ChatCompletionParams,
		rejection: Rejection,
		session: RepairSession,
	): ChatCompletionParams | null {
		const { spent, pending } = session
		const key = this.routeKey(provider, params)
		switch (rejection.kind) {
			case 'tool-pairing': {
				if (spent.has('tool-pairing')) return null
				spent.add('tool-pairing')
				const repaired = repairOnce(params.messages)
				if (repaired === null) return null
				this.hooks.debug?.(`Retrying after a tool-history rejection (${key})`)
				return { ...params, messages: repaired }
			}
			case 'reasoning': {
				if (spent.has('reasoning')) return null
				spent.add('reasoning')
				const messages = stripReasoning(params.messages)
				if (messages === params.messages) return null
				pending.reasoningOff.add(key)
				let next: ChatCompletionParams = { ...params, messages }
				// With thinking on, a tool turn that carries no thinking block is
				// itself refused ("Expected `thinking` … but found `tool_use`"), so
				// the two go together: neither is asked for in this resend.
				if (params.thinking !== undefined && params.thinking.type !== 'disabled') {
					next = withoutParameters(next, new Set<RejectedParameter>(['thinking']))
					const names = pending.latched.get(key) ?? new Set<RejectedParameter>()
					names.add('thinking')
					pending.latched.set(key, names)
				}
				this.hooks.debug?.(`Retrying without reasoning blocks (${key})`)
				return next
			}
			case 'parameter': {
				const fresh = rejection.parameters.filter((name) => !spent.has(`param:${name}`))
				if (fresh.length === 0) return null
				for (const name of fresh) spent.add(`param:${name}`)
				const names = pending.latched.get(key) ?? new Set<RejectedParameter>()
				for (const name of fresh) names.add(name)
				pending.latched.set(key, names)
				this.hooks.debug?.(
					`Retrying without parameters the model refused (${key}): ${fresh.join(', ')}`,
				)
				return withoutParameters(params, new Set(fresh))
			}
			case 'media':
				return this.nextWithoutMedia(provider, params, rejection, session)
		}
	}

	private nextWithoutMedia(
		provider: Pick<LLMProvider, 'id'>,
		params: ChatCompletionParams,
		rejection: Extract<Rejection, { kind: 'media' }>,
		session: RepairSession,
	): ChatCompletionParams | null {
		const { spent, stripsByIndex, pending } = session
		const slots = listMedia(params.messages)
		if (slots.length === 0) return null

		let victims: MediaSlot[] = []
		let limited = false
		if (!rejection.generic) {
			if (rejection.messageIndex !== undefined) {
				const used = stripsByIndex.get(rejection.messageIndex) ?? 0
				if (used < MAX_STRIPS_PER_INDEX) {
					stripsByIndex.set(rejection.messageIndex, used + 1)
					victims =
						mediaAtWireIndex(
							params.messages,
							slots,
							this.served(provider, params).providerId,
							rejection.messageIndex,
							rejection.contentIndex,
						) ?? []
				}
			}
			if (victims.length === 0) {
				// No exact index: the newest message that carries media.
				const newest = slots[slots.length - 1]
				if (newest === undefined) return null
				const count = (stripsByIndex.get(-1) ?? 0) + 1
				if (count > MAX_STRIPS_PER_INDEX) return null
				stripsByIndex.set(-1, count)
				victims = slots.filter((slot) => slot.messageIndex === newest.messageIndex)
			}
		} else {
			// The media steps, then halving for smaller requests, down to
			// none: each step keeps fewer than the request held, newest first.
			const limit =
				GENERIC_MEDIA_LIMITS.find((candidate) => candidate < slots.length) ??
				Math.floor(slots.length / 2)
			spent.add(`limit:${limit}`)
			pending.mediaLimit = Math.min(pending.mediaLimit ?? limit, limit)
			victims = slots.slice(0, slots.length - limit)
			limited = true
		}

		// A count limit teaches a limit, not that these files are faulty.
		if (!limited) for (const slot of victims) pending.rejectedMedia.add(slot.fingerprint)
		this.hooks.debug?.(`Retrying without ${victims.length} media the provider rejected`)

		let lastUser = -1
		for (const [index, message] of params.messages.entries()) {
			if (message.role === 'user') lastUser = index
		}
		const kinds = new Set(victims.map((slot) => slot.kind))
		const removal: MediaRemoval = {
			count: victims.length,
			kind: kinds.size === 1 ? ([...kinds][0] as 'image' | 'document') : 'media',
			current: victims.some((slot) => slot.source === 'user' && slot.messageIndex === lastUser),
			limit: limited,
		}
		const before = session.removal
		session.removal = before
			? {
					count: before.count + removal.count,
					kind: before.kind === removal.kind ? before.kind : 'media',
					current: before.current || removal.current,
					limit: before.limit && removal.limit,
				}
			: removal
		return { ...params, messages: removeMedia(params.messages, victims, limited) }
	}

	/**
	 * Send `params`, repairing and resending a request the provider rejects as
	 * invalid until it is accepted or nothing more can be changed. The original
	 * rejection is thrown when nothing applies, and what the guesses taught is
	 * forgotten unless a resend was accepted.
	 */
	async *stream(
		provider: LLMProvider,
		params: ChatCompletionParams,
		session: RepairSession = this.session(),
	): AsyncIterable<StreamChunk> {
		let current = this.prepare(provider, params)
		let firstError: unknown

		for (;;) {
			let produced = false
			let reported = false
			try {
				for await (const chunk of provider.chatStream(current)) {
					if (isAccepted(chunk)) {
						produced = true
						this.commit(session)
						if (session.removal !== undefined && !reported) {
							reported = true
							const removal = session.removal
							session.removal = undefined
							await this.hooks.onMediaRemoved?.(removal)
						}
					}
					yield chunk
				}
				this.commit(session)
				if (session.removal !== undefined && !reported) {
					const removal = session.removal
					session.removal = undefined
					await this.hooks.onMediaRemoved?.(removal)
				}
				return
			} catch (error) {
				if (current.signal?.aborted) throw current.signal.reason
				if (produced) throw error
				firstError ??= error
				const forget = (): never => {
					session.pending = emptyLearned()
					session.removal = undefined
					throw firstError
				}
				if (session.repairs >= MAX_REPAIRS_PER_REQUEST) return forget()
				if (isHandledElsewhere(error, current)) return forget()
				const rejection = classifyRequestRejection(error, current)
				if (rejection === null) return forget()
				const step = this.next(provider, current, rejection, session)
				if (step === null) return forget()
				session.repairs++
				current = step
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
	if (isProviderRejectedImageError(error) && findSingleRequestImage(params.messages) !== null) {
		return true
	}
	return isImageInputRefusal(error)
}
