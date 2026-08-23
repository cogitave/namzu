import { execFileSync } from 'node:child_process'
import Anthropic from '@anthropic-ai/sdk'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	Citation,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	ProviderRoute,
	ReasoningBlock,
	ReasoningEffort,
	StreamChunk,
	ThinkingConfig,
	TokenUsage,
	ToolChoice,
	ToolResultContent,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	assertStrictSchema,
	isCallerAbortError,
	isProviderRequestError,
	modelVersionAtLeast,
	providerVendorError,
	toSchemaDialect,
	toolResultToText,
} from '@namzu/sdk'
import { attributionHeaders } from '@namzu/sdk'
import {
	MODEL_ID_GRAMMAR,
	resolveEffort,
	resolveThinkingBody,
	resolveThinkingCapability,
} from './thinking-capability.js'
import type { AnthropicConfig } from './types.js'

// Floor for `max_tokens` when neither the request nor the provider
// config supplied one. Anthropic's API requires the field, so we cannot
// truly omit it — but 4096 (the original SDK example default) is far
// below what Sonnet 4.6 / Opus 4.7 natively emit, and would silently
// clip 20k-word documents. 64k is the canonical "long output" budget
// these models advertise; the model still stops at its own native
// ceiling, so passing 64k just means "don't bound below the model".
const DEFAULT_MAX_TOKENS = 64_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 0

// Claude Code OAuth tokens are scoped to Claude Code usage. Anthropic
// authorizes them only when three signals are all present, else 401:
//   1. the OAuth beta headers,
//   2. a `claude-code/<version>` user-agent (version validated server-side),
//   3. the CLI application marker,
//   4. a system prompt whose first block is the Claude Code identity line.
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20'
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
const CLAUDE_CODE_VERSION_FALLBACK = '2.1.74'

let claudeCodeVersionCache: string | null = null
function detectClaudeCodeVersion(): string {
	if (claudeCodeVersionCache !== null) return claudeCodeVersionCache
	for (const bin of ['claude', 'claude-code']) {
		try {
			const out = execFileSync(bin, ['--version'], {
				encoding: 'utf8',
				timeout: 5_000,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
				.trim()
				.split(/\s+/)[0]
			if (out && /^\d/.test(out)) {
				claudeCodeVersionCache = out
				return out
			}
		} catch {
			// try next binary
		}
	}
	claudeCodeVersionCache = CLAUDE_CODE_VERSION_FALLBACK
	return CLAUDE_CODE_VERSION_FALLBACK
}

// --------------------------------------------------------------------------------------
// Message translation: @namzu/sdk → Anthropic Messages API
// --------------------------------------------------------------------------------------

/**
 * Anthropic prompt-cache breakpoint marker. A `cache_control` on a block
 * caches everything up to and including that block in the fixed render
 * order tools → system → messages (max 4 breakpoints per request).
 */
interface AnthropicCacheControl {
	type: 'ephemeral'
}

interface AnthropicTextBlock {
	type: 'text'
	text: string
	cache_control?: AnthropicCacheControl
}

interface AnthropicToolUseBlock {
	type: 'tool_use'
	id: string
	name: string
	input: unknown
	cache_control?: AnthropicCacheControl
}

interface AnthropicToolResultBlock {
	type: 'tool_result'
	tool_use_id: string
	/** Text, or the blocks this wire accepts inside a tool result. */
	content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
	cache_control?: AnthropicCacheControl
}

interface AnthropicImageBlock {
	type: 'image'
	source: { type: 'base64'; media_type: string; data: string }
	cache_control?: AnthropicCacheControl
}

interface AnthropicToolParam {
	name: string
	description: string
	input_schema: unknown
	strict?: boolean
	cache_control?: AnthropicCacheControl
}

/** Shape of an SDK `MessageAttachment` (read structurally to avoid coupling). */
/**
 * The attachment shape this driver reads, structurally.
 *
 * The `stored` member is not decoration. `msg` is CAST to a shape carrying
 * these, so widening `MessageAttachment` in the SDK does not reach this
 * file — the compiler checked the cast, not the source. Without the member
 * below, a stored attachment arriving here has `data: undefined`, and the
 * driver sends `data: undefined` to the API in a block it built happily.
 * The sibling OpenAI driver reads the real SDK type and was caught by the
 * type system; this one was not, and that difference is why the member is
 * spelled out rather than assumed.
 */
type AttachmentLike =
	| {
			readonly type?: 'image' | 'document'
			readonly data: string
			readonly mediaType: string
			readonly name?: string
			readonly citations?: boolean
	  }
	| {
			readonly type: 'stored'
			readonly ref: string
			readonly mediaType: string
			readonly name?: string
			readonly citations?: boolean
	  }

/**
 * A reasoning block in this provider's native history shape.
 *
 * The signature is cryptographic and verified upstream: a block echoed
 * back with its text edited, its signature dropped, or its order changed
 * is rejected, which fails the whole conversation rather than one block.
 * So this is a passthrough, never a re-render.
 */
interface AnthropicThinkingBlock {
	type: 'thinking' | 'redacted_thinking'
	thinking?: string
	signature?: string
	data?: string
	cache_control?: AnthropicCacheControl
}

type AnthropicReplayBlock =
	| { type: 'thinking'; thinking: string; signature: string }
	| { type: 'redacted_thinking'; data: string }

interface AnthropicReplayState {
	readonly kind: 'namzu-anthropic-reasoning'
	readonly version: 1
	readonly route: ProviderRoute
	readonly blocks: readonly AnthropicReplayBlock[]
}

interface AnthropicDocumentBlock {
	type: 'document'
	source: { type: 'base64'; media_type: string; data: string }
	title?: string
	citations?: { enabled: true }
	/** A document is the block most worth a breakpoint, being the largest. */
	cache_control?: AnthropicCacheControl
}

type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicImageBlock
	| AnthropicDocumentBlock
	| AnthropicThinkingBlock

interface AnthropicMessageParam {
	role: 'user' | 'assistant'
	content: string | AnthropicContentBlock[]
}

/**
 * System messages become a block array (one block per SystemMessage) so the
 * runtime's `cacheHint` segment boundaries survive into the request: the
 * PromptBuilder tags the static segment `'cache'` and the per-run dynamic
 * segment `'ephemeral'`. When caching is enabled, the LAST `'cache'`-tagged
 * block carries the `cache_control` breakpoint — everything up to it
 * (tools + static system) is cached; dynamic blocks after it are not.
 */
function extractSystem(
	messages: ChatCompletionParams['messages'],
	cachingEnabled: boolean,
): AnthropicTextBlock[] | undefined {
	const blocks: AnthropicTextBlock[] = []
	let lastCacheTagged: AnthropicTextBlock | undefined
	for (const msg of messages) {
		if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.length > 0) {
			const block: AnthropicTextBlock = { type: 'text', text: msg.content }
			blocks.push(block)
			if (msg.cacheHint === 'cache') lastCacheTagged = block
		}
	}
	if (blocks.length === 0) return undefined
	if (cachingEnabled && lastCacheTagged) {
		lastCacheTagged.cache_control = { type: 'ephemeral' }
	}
	return blocks
}

/**
 * Resolve the exact target member for this adapter call.
 */
function resolveAnthropicRoute(model: string, candidate: ProviderRoute | undefined): ProviderRoute {
	if (candidate === undefined) return { providerId: 'anthropic', model, chainIndex: 0 }
	if (
		candidate.providerId !== 'anthropic' ||
		candidate.model !== model ||
		!Number.isSafeInteger(candidate.chainIndex) ||
		candidate.chainIndex < 0
	) {
		throw new Error(
			'AnthropicProvider: providerRoute must name this provider, the requested model, and a non-negative integer chainIndex.',
		)
	}
	return candidate
}

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean {
	return (
		left.providerId === right.providerId &&
		left.model === right.model &&
		left.chainIndex === right.chainIndex
	)
}

function isAnthropicReplayState(value: unknown): value is AnthropicReplayState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const state = value as Record<string, unknown>
	const route = state.route
	if (
		state.kind !== 'namzu-anthropic-reasoning' ||
		state.version !== 1 ||
		typeof route !== 'object' ||
		route === null ||
		Array.isArray(route) ||
		typeof (route as Record<string, unknown>).providerId !== 'string' ||
		typeof (route as Record<string, unknown>).model !== 'string' ||
		!Number.isSafeInteger((route as Record<string, unknown>).chainIndex) ||
		((route as Record<string, unknown>).chainIndex as number) < 0 ||
		!Array.isArray(state.blocks)
	) {
		return false
	}
	return state.blocks.every((value) => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
		const block = value as Record<string, unknown>
		return block.type === 'thinking'
			? typeof block.thinking === 'string' && typeof block.signature === 'string'
			: block.type === 'redacted_thinking' && typeof block.data === 'string'
	})
}

function durableAnthropicReasoning(
	reasoning: readonly ReasoningBlock[] | undefined,
): readonly AnthropicReplayBlock[] | undefined {
	if (!reasoning || reasoning.length === 0) return undefined
	const blocks: AnthropicReplayBlock[] = []
	for (const block of reasoning) {
		if (block.type === 'thinking') {
			if (
				typeof block.text !== 'string' ||
				typeof block.signature !== 'string' ||
				block.signature.length === 0 ||
				block.encrypted !== undefined
			) {
				return undefined
			}
			blocks.push({
				type: 'thinking',
				thinking: block.text,
				signature: block.signature,
			})
			continue
		}
		if (
			typeof block.encrypted !== 'string' ||
			block.encrypted.length === 0 ||
			block.text !== undefined ||
			block.signature !== undefined
		) {
			return undefined
		}
		blocks.push({ type: 'redacted_thinking', data: block.encrypted })
	}
	return blocks
}

function replayBlocksEqual(
	left: readonly AnthropicReplayBlock[],
	right: readonly AnthropicReplayBlock[],
): boolean {
	return (
		left.length === right.length &&
		left.every((block, index) => {
			const other = right[index]
			if (!other || block.type !== other.type) return false
			return block.type === 'thinking' && other.type === 'thinking'
				? block.thinking === other.thinking && block.signature === other.signature
				: block.type === 'redacted_thinking' &&
						other.type === 'redacted_thinking' &&
						block.data === other.data
		})
	)
}

/**
 * The reasoning blocks an assistant message may restore in native wire form.
 *
 * Durable reasoning alone is not authority to emit signed provider metadata.
 * The adapter-private envelope must be well-formed, agree with that durable
 * content, and belong to the exact target route. Otherwise the assistant text
 * and tool calls remain usable while native thinking is omitted.
 */
function replayReasoning(
	msg: Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }>,
	targetRoute: ProviderRoute,
): AnthropicThinkingBlock[] {
	const source = msg.source
	if (!source || source.type !== 'model' || !sameRoute(source, targetRoute)) return []
	const state = source.replayState
	if (!isAnthropicReplayState(state) || !sameRoute(state.route, source)) return []
	const durable = durableAnthropicReasoning(msg.reasoning)
	if (!durable || !replayBlocksEqual(durable, state.blocks)) return []
	return state.blocks.map((block) => ({ ...block }))
}

/**
 * A tool result, in the richest form this wire accepts.
 *
 * The blocks used to be `JSON.stringify`d, so a screenshot reached the
 * model as a wall of quoted base64 — the one thing the SDK's own degrade
 * helper exists to avoid, and pure cost besides: the model paid for every
 * character and could read none of them. This wire carries image blocks in
 * a tool result natively, so they are sent as images.
 *
 * A document block still degrades to the named placeholder: tool results
 * on this wire take text and images, not documents, and inventing an image
 * block around a PDF would fail the request instead of the block.
 */
function toolResultContent(
	content: ToolResultContent | undefined,
): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
	if (content === undefined) return ''
	if (typeof content === 'string') return content

	const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = []
	for (const block of content) {
		if (block.type === 'image') {
			blocks.push({
				type: 'image',
				source: {
					type: 'base64',
					media_type: block.mediaType,
					data: block.data,
				},
			})
			continue
		}
		const text = toolResultToText([block])
		if (text.length > 0) blocks.push({ type: 'text', text })
	}
	// An empty array is rejected upstream; an empty string is not.
	return blocks.length > 0 ? blocks : ''
}

function toAnthropicMessages(
	messages: ChatCompletionParams['messages'],
	targetRoute: ProviderRoute,
): AnthropicMessageParam[] {
	const out: AnthropicMessageParam[] = []
	let pendingToolResults: AnthropicToolResultBlock[] = []

	const flushToolResults = () => {
		if (pendingToolResults.length > 0) {
			out.push({ role: 'user', content: pendingToolResults })
			pendingToolResults = []
		}
	}

	for (const msg of messages) {
		if (msg.role === 'system') continue

		if (msg.role === 'tool') {
			const toolMsg = msg as {
				toolCallId?: string
				content?: ToolResultContent
			}
			pendingToolResults.push({
				type: 'tool_result',
				tool_use_id: toolMsg.toolCallId ?? 'unknown',
				content: toolResultContent(toolMsg.content),
			})
			continue
		}

		flushToolResults()

		if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
			const blocks: AnthropicContentBlock[] = [...replayReasoning(msg, targetRoute)]
			if (msg.content && typeof msg.content === 'string') {
				blocks.push({ type: 'text', text: msg.content })
			}
			for (const tc of msg.toolCalls) {
				let parsedInput: unknown = {}
				try {
					parsedInput = JSON.parse(tc.function.arguments || '{}')
				} catch {
					parsedInput = {}
				}
				blocks.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.function.name,
					input: parsedInput,
				})
			}
			out.push({ role: 'assistant', content: blocks })
			continue
		}

		// An assistant turn that reasoned replays those blocks even when it
		// called no tool: dropping them invalidates the turn upstream.
		const replayed = msg.role === 'assistant' ? replayReasoning(msg, targetRoute) : []
		const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
		if (replayed.length > 0) {
			const trailing: AnthropicContentBlock[] =
				content.length > 0 ? [{ type: 'text', text: content }] : []
			out.push({ role: 'assistant', content: [...replayed, ...trailing] })
			continue
		}
		// User message with image attachments → multimodal content blocks
		// (text first, then each image as a base64 image block).
		const attachments = (msg as { attachments?: readonly AttachmentLike[] }).attachments
		if (msg.role === 'user' && attachments && attachments.length > 0) {
			const blocks: AnthropicContentBlock[] = []
			if (content.length > 0) blocks.push({ type: 'text', text: content })
			for (const att of attachments) {
				// A document is not an image with a different media type. It
				// used to be mapped as one, so a PDF went up as an image block
				// the API rejects — while the capability set claimed documents
				// were supported. The native block buys page structure, OCR,
				// and the citations the SDK contract already has a slot for.
				if (att.type === 'document') {
					blocks.push({
						type: 'document',
						source: {
							type: 'base64',
							media_type: att.mediaType,
							data: att.data,
						},
						...(att.name ? { title: att.name } : {}),
						// Opt-in: citations cost tokens, so they are requested
						// only when the caller asked to be able to check the
						// answer.
						...(att.citations ? { citations: { enabled: true as const } } : {}),
					})
					continue
				}
				if (att.type === 'stored') {
					// Unreachable through `query`, which resolves stored
					// attachments before a driver sees them. REFUSED rather than
					// skipped: a user message that silently lost its image has
					// the model answering about a picture it never saw, and
					// nothing in the transcript says why.
					throw new Error(
						`A stored attachment ("${att.ref}") reached the driver unresolved. Resolve it against the run's attachment store before sending.`,
					)
				}
				blocks.push({
					type: 'image',
					source: { type: 'base64', media_type: att.mediaType, data: att.data },
				})
			}
			out.push({ role: 'user', content: blocks })
			continue
		}
		out.push({
			role: msg.role === 'assistant' ? 'assistant' : 'user',
			content,
		})
	}

	flushToolResults()
	return out
}

function toAnthropicTools(
	params: ChatCompletionParams,
	cachingEnabled: boolean,
	strictToolUseEnabled: boolean,
): AnthropicToolParam[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	const enforcedNames = new Set(params.enforceToolInputSchema ?? [])
	const tools: AnthropicToolParam[] = params.tools.map((t) => {
		const strict = strictToolUseEnabled && enforcedNames.has(t.function.name)
		// Checked exactly where the pairing is made, because this is the only
		// place both facts are in hand: that this schema is going out, and that
		// this driver is about to vouch for it. A schema outside the strict
		// subset is not degraded by the vendor — the whole request is rejected,
		// so one unexpressible field takes down every other tool with it.
		if (strict) assertStrictSchema(t.function.name, t.function.parameters)
		return {
			name: t.function.name,
			description: t.function.description ?? '',
			// This wire parses draft 2020-12, and the renderer emits draft-07.
			// The two disagree about tuples — draft-07 puts the positional
			// schemas in `items`, 2020-12 in `prefixItems` — and the wire
			// rejects the WHOLE request for it, not the one field. Converting
			// here rather than in the renderer keeps the dialect where the
			// knowledge is: only this file knows which wire it is talking to.
			input_schema: toSchemaDialect(
				(t.function.parameters as Record<string, unknown> | undefined) ?? {
					type: 'object',
				},
				'2020-12',
			),
			...(strict ? { strict: true } : {}),
		}
	})
	if (cachingEnabled) {
		// Breakpoint on the tools-array tail: tools render at position 0 of
		// the cache prefix, so this caches every tool schema even when the
		// system/message breakpoints downstream get invalidated.
		const tail = tools[tools.length - 1]
		if (tail) tail.cache_control = { type: 'ephemeral' }
	}
	return tools
}

function shouldUseStrictToolInputs(
	model: string,
	mode: AnthropicConfig['strictToolUse'] = 'auto',
): boolean {
	if (mode === 'on') return true
	if (mode === 'off') return false

	const normalized = model.toLowerCase()
	if (/^(?:anthropic\/)?claude-mythos-preview$/.test(normalized)) return true
	// Shared matcher. The copy that stood here read the 8-digit date suffix as
	// the minor version, so `claude-sonnet-4-20250514` compared as 4.20250514
	// and cleared this 4.5 gate — strict tool inputs were enabled for a model
	// below the threshold.
	return modelVersionAtLeast(normalized, MODEL_ID_GRAMMAR, 4, 5)
}

function toAnthropicToolChoice(tc?: ToolChoice, parallelToolCalls?: boolean): unknown {
	// Anthropic expresses "no parallel tool calls" as a field ON tool_choice,
	// not a top-level param. Only auto/any/tool accept it ('none' fires no
	// tools, so the field is meaningless there).
	const disable = parallelToolCalls === false ? { disable_parallel_tool_use: true } : undefined
	if (tc === undefined) {
		return disable ? { type: 'auto', ...disable } : undefined
	}
	if (tc === 'auto') return { type: 'auto', ...disable }
	if (tc === 'required') return { type: 'any', ...disable }
	// 'none' is first-class on the Messages API ("prevents Claude from using
	// any tools"). Mapping it this way — instead of omitting the tools param —
	// keeps the tools+system cache prefix intact and avoids a 400 when the
	// conversation history still carries tool_use/tool_result blocks.
	if (tc === 'none') return { type: 'none' }
	if (typeof tc === 'object' && tc.type === 'function') {
		return { type: 'tool', name: tc.function.name, ...disable }
	}
	return undefined
}

/**
 * Final cache breakpoint: the last content block of the last non-empty
 * message. Caches the whole conversation prefix so the next iteration
 * (which only appends messages) reads the prior history at cache rates.
 */
function applyMessageCacheBreakpoint(messages: AnthropicMessageParam[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (!msg) continue
		if (typeof msg.content === 'string') {
			if (msg.content.length === 0) continue
			msg.content = [
				{
					type: 'text',
					text: msg.content,
					cache_control: { type: 'ephemeral' },
				},
			]
			return
		}
		if (msg.content.length > 0) {
			const last = msg.content[msg.content.length - 1]
			if (last) last.cache_control = { type: 'ephemeral' }
			return
		}
	}
}

// --------------------------------------------------------------------------------------
// Usage parsing
// --------------------------------------------------------------------------------------

interface RawAnthropicUsage {
	input_tokens?: number
	output_tokens?: number
	cache_read_input_tokens?: number | null
	cache_creation_input_tokens?: number | null
	/**
	 * Reasoning share of the output, when the vendor reports it.
	 *
	 * Counted INSIDE `output_tokens`, so it is carried as a breakdown rather
	 * than added to the total. When streaming, this arrives only on the final
	 * `message_delta` — earlier events carry no breakdown at all, which is why
	 * an absent value has to mean "not reported" and not "zero".
	 */
	output_tokens_details?: { thinking_tokens?: number } | null
}

function emptyUsage(): TokenUsage {
	return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

function parseUsage(raw?: RawAnthropicUsage): TokenUsage {
	if (!raw) return emptyUsage()
	const input = raw.input_tokens ?? 0
	const output = raw.output_tokens ?? 0
	const thinking = raw.output_tokens_details?.thinking_tokens
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: input + output,
		cachedTokens: raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
		// Only when reported. Defaulting to 0 would say "this turn did no
		// thinking" about every turn on every driver that stays silent, and
		// about every streamed event before the last one.
		...(thinking !== undefined ? { reasoningTokens: thinking } : {}),
	}
}

// --------------------------------------------------------------------------------------
// Finish reason mapping
// --------------------------------------------------------------------------------------

type NamzuFinishReason = ChatCompletionResponse['finishReason']

function mapStopReason(reason?: string | null): NamzuFinishReason {
	switch (reason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop'
		case 'tool_use':
			return 'tool_calls'
		case 'max_tokens':
			return 'length'
		default:
			return 'stop'
	}
}

// --------------------------------------------------------------------------------------
// Stream event types
// --------------------------------------------------------------------------------------

/**
 * A cited passage as it arrives on the wire.
 *
 * The location is reported three different ways depending on how the
 * provider segmented the source, which is why the SDK's `Citation` keeps
 * a discriminated union rather than flattening everything to a page
 * number: two of the three shapes have no page to report.
 */
interface RawAnthropicCitation {
	type?: string
	cited_text?: string
	document_index?: number
	document_title?: string | null
	start_page_number?: number
	end_page_number?: number
	start_char_index?: number
	end_char_index?: number
	start_block_index?: number
	end_block_index?: number
}

/**
 * Map a wire citation onto the SDK's shape.
 *
 * Returns undefined rather than inventing a location: a citation whose
 * source segment cannot be named is worse than none, because it looks
 * checkable and is not.
 */
function toCitation(raw: RawAnthropicCitation, index: number): Citation | undefined {
	const citedText = raw.cited_text
	if (!citedText) return undefined

	const location = (():
		| { kind: 'page'; start: number; end: number }
		| { kind: 'char'; start: number; end: number }
		| { kind: 'block'; start: number; end: number }
		| undefined => {
		if (raw.start_page_number !== undefined && raw.end_page_number !== undefined) {
			return {
				kind: 'page',
				start: raw.start_page_number,
				end: raw.end_page_number,
			}
		}
		if (raw.start_char_index !== undefined && raw.end_char_index !== undefined) {
			return {
				kind: 'char',
				start: raw.start_char_index,
				end: raw.end_char_index,
			}
		}
		if (raw.start_block_index !== undefined && raw.end_block_index !== undefined) {
			return {
				kind: 'block',
				start: raw.start_block_index,
				end: raw.end_block_index,
			}
		}
		return undefined
	})()
	if (!location) return undefined

	return {
		citedText,
		documentIndex: raw.document_index ?? index,
		...(raw.document_title ? { documentTitle: raw.document_title } : {}),
		location,
	}
}

interface StreamEvent {
	type: string
	message?: { id?: string; usage?: RawAnthropicUsage }
	index?: number
	content_block?: {
		type?: string
		id?: string
		name?: string
		data?: string
		thinking?: string
		signature?: string
	}
	delta?: {
		type?: string
		text?: string
		partial_json?: string
		stop_reason?: string | null
		citation?: RawAnthropicCitation
		thinking?: string
		signature?: string
	}
	usage?: RawAnthropicUsage
}

// --------------------------------------------------------------------------------------
// AnthropicProvider
// --------------------------------------------------------------------------------------

/**
 * Full capability set — this driver maps tools (`toAnthropicTools`),
 * streams natively, and maps user-message image `attachments` into
 * base64 image content blocks (`toAnthropicMessages`).
 */
export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
}

export class AnthropicProvider implements LLMProvider {
	readonly id = 'anthropic'
	readonly name = 'Anthropic'
	readonly capabilities = ANTHROPIC_CAPABILITIES

	private client: Anthropic
	private config: AnthropicConfig

	constructor(config: AnthropicConfig) {
		if (!config.apiKey && !config.authToken) {
			throw new Error('AnthropicProvider: either `apiKey` or `authToken` is required')
		}
		this.config = config

		const clientOpts: Record<string, unknown> = {
			timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
		}
		if (config.authToken) {
			clientOpts.authToken = config.authToken
			// OAuth routes require both beta flags + a Claude Code user-agent;
			// without that identity the Messages endpoint does not admit the token
			// as Claude Code subscription traffic. The system-prompt identity block
			// is added per request in buildCreateParams.
			const headers: Record<string, string> = {
				'anthropic-beta': OAUTH_BETAS,
				'user-agent': `claude-code/${detectClaudeCodeVersion()} (external, cli)`,
				'x-app': 'cli',
				...(config.defaultHeaders ?? {}),
			}
			clientOpts.defaultHeaders = headers
		} else {
			clientOpts.apiKey = config.apiKey
			// This branch ONLY. The OAuth branch above sends a Claude Code
			// user-agent because subscription inference requires it — that is
			// load-bearing impersonation, and merging attribution
			// into it would break authentication, not improve labelling.
			clientOpts.defaultHeaders = {
				...attributionHeaders(),
				...(config.defaultHeaders ?? {}),
			}
		}
		if (config.baseURL) clientOpts.baseURL = config.baseURL

		this.client = new Anthropic(clientOpts)
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.config.model
		if (!model) {
			throw new Error(
				'AnthropicProvider: no model specified. Pass `model` on the chat params or set a default via config.',
			)
		}
		return model
	}

	private buildCreateParams(
		params: ChatCompletionParams,
		stream: boolean,
	): Record<string, unknown> {
		// The runtime requests caching via `params.cacheControl` on every
		// iteration. Honoring it costs three of the four allowed breakpoints:
		// tools tail + static-system tail + last message block (render order
		// is tools → system → messages, so each later breakpoint covers all
		// earlier sections too).
		const cachingEnabled = params.cacheControl !== undefined
		const model = this.resolveModel(params)
		const providerRoute = resolveAnthropicRoute(model, params.providerRoute)
		const system = extractSystem(params.messages, cachingEnabled)
		const messages = toAnthropicMessages(params.messages, providerRoute)
		if (cachingEnabled) applyMessageCacheBreakpoint(messages)
		const tools = toAnthropicTools(
			params,
			cachingEnabled,
			shouldUseStrictToolInputs(model, this.config.strictToolUse),
		)
		const toolChoice = toAnthropicToolChoice(params.toolChoice, params.parallelToolCalls)

		const body: Record<string, unknown> = {
			model,
			messages,
			max_tokens: params.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
			stream,
		}

		if (this.config.authToken) {
			// OAuth: the first system block must be the Claude Code identity
			// line or Anthropic rejects the request. Emit the block-array form
			// with the identity prefix first; cache breakpoints (if any) stay
			// on the tagged blocks behind it, so the ordering survives.
			const ccBlock: AnthropicTextBlock = {
				type: 'text',
				text: CLAUDE_CODE_SYSTEM_PREFIX,
			}
			body.system = system ? [ccBlock, ...system] : [ccBlock]
		} else if (system) {
			body.system = system
		}
		if (tools) body.tools = tools
		// tool_choice is only legal alongside tools (the API rejects it
		// otherwise) — this also drops a parallelToolCalls-derived choice on
		// tool-less requests.
		if (tools && toolChoice) body.tool_choice = toolChoice
		// Resolved against the model rather than sent verbatim. This used to
		// map `enabled` straight through and everything else to `disabled`,
		// which fails outright on current models: `thinking.type.enabled` is
		// rejected with a 400 from 4.7 onward, `adaptive` is rejected on 4.5
		// and earlier, and the always-on models reject `disabled`. One body
		// for every model is not a compromise here, it is a failed request.
		//
		// `display` is carried through now too. It defaults to `omitted` on
		// newer models, so a caller who wanted to show reasoning and never
		// serialized the field received thinking blocks with empty text and
		// nothing to explain why.
		const capability = resolveThinkingCapability(model)
		const thinkingBody = resolveThinkingBody(params.thinking, capability)
		if (thinkingBody) body.thinking = thinkingBody

		// A sibling of `thinking`, not a field inside it — and gated on the
		// model, since only some accept it at all.
		const effort = resolveEffort(params.effort, thinkingBody, capability, model)
		// Merged rather than assigned. `output_config` is a shared envelope on
		// this wire — a structured-output format and a task budget live in it
		// too, and `responseFormat` already exists on the params unhandled
		// here. Assigning would mean whoever wires the next one silently
		// deletes effort, or has effort silently delete theirs, depending only
		// on which line ran last.
		if (effort)
			body.output_config = {
				...(body.output_config as object | undefined),
				effort,
			}
		if (params.temperature !== undefined) body.temperature = params.temperature
		if (params.topP !== undefined) body.top_p = params.topP
		if (params.topK !== undefined) body.top_k = params.topK
		if (params.stop) body.stop_sequences = params.stop

		return body
	}

	/**
	 * The SDK's `messages.create` is overloaded on the `stream` flag. We build
	 * the request as an untyped object bag and narrow the response shape ourselves.
	 * Casting via `unknown` keeps us out of `any` territory while acknowledging
	 * that the translation layer bridges two type worlds.
	 */
	private createRaw(
		body: Record<string, unknown>,
		opts?: { signal?: AbortSignal },
	): Promise<unknown> {
		const create = this.client.messages.create as unknown as (
			body: Record<string, unknown>,
			options?: { signal?: AbortSignal },
		) => Promise<unknown>
		// Pass the caller AbortSignal as the SDK's per-request RequestOptions so
		// aborting it tears down the in-flight HTTP/2 SSE request (rejects with
		// APIUserAbortError). A non-aborted signal is identical to omitting it.
		return create.call(this.client.messages, body, { signal: opts?.signal })
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const providerRoute = resolveAnthropicRoute(this.resolveModel(params), params.providerRoute)
		const createParams = this.buildCreateParams(params, true)
		const signal = params.signal

		let stream: AsyncIterable<StreamEvent>
		try {
			stream = (await this.createRaw(createParams, {
				signal,
			})) as AsyncIterable<StreamEvent>
		} catch (err) {
			// The vendor SDK builds its error message FROM the response body, so a
			// credential the upstream echoed back is already inside `err.message`
			// before this code runs (proven with a planted fake token). Classify from
			// the status and drop the vendor error entirely — no re-throw, no
			// `cause`, because a `cause` is exactly what a structured logger walks.
			if (isCallerAbortError(err, signal)) throw signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'anthropic', error: err })
		}

		let messageId = ''
		// Track active tool-use blocks by content_block index so input_json_delta
		// fragments can reference the right tool call.
		const activeTools = new Map<number, { id: string; name: string }>()
		const activeReasoning = new Set<number>()
		const nativeReasoning = new Map<number, AnthropicReplayBlock>()
		let replayStateEmitted = false
		const completedReplayState = (): AnthropicReplayState | undefined => {
			if (replayStateEmitted || activeReasoning.size > 0 || nativeReasoning.size === 0) {
				return undefined
			}
			const blocks = [...nativeReasoning.entries()]
				.sort(([left], [right]) => left - right)
				.map(([, block]) => ({ ...block }))
			if (
				blocks.some((block) =>
					block.type === 'thinking' ? block.signature.length === 0 : block.data.length === 0,
				)
			) {
				return undefined
			}
			replayStateEmitted = true
			return {
				kind: 'namzu-anthropic-reasoning',
				version: 1,
				route: providerRoute,
				blocks,
			}
		}

		// Anthropic Messages API streams over SSE. Do not impose a
		// provider-local 90s idle cutoff by default: long reasoning or
		// long tool-argument generation can legitimately pause between
		// SSE events, and cutting it here turns a healthy Messages API
		// run into a false "tool input truncated" failure. Deployments
		// that still need a per-event watchdog can opt in via
		// `streamIdleTimeoutMs`; otherwise the request timeout and caller
		// AbortSignal own lifecycle cancellation.
		const streamIdleTimeoutMs = this.config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
		const iter = (stream as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]()
		const nextWithIdleTimeout = async (): Promise<IteratorResult<StreamEvent>> => {
			if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
				return iter.next()
			}
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				return await Promise.race([
					iter.next(),
					new Promise<IteratorResult<StreamEvent>>((_, reject) => {
						timer = setTimeout(() => {
							reject(
								new ProviderRequestError({
									kind: 'network',
									providerId: 'anthropic',
									detail: `stream idle for ${Math.round(streamIdleTimeoutMs / 1000)}s — aborting so the run lifecycle can emit run_failed`,
								}),
							)
						}, streamIdleTimeoutMs)
					}),
				])
			} finally {
				if (timer !== undefined) clearTimeout(timer)
			}
		}

		try {
			for (;;) {
				// Cheap between-chunk abort check: if a Stop fired, stop pulling
				// (the runtime also races this, and the SDK request is aborted).
				signal?.throwIfAborted()
				const result = await nextWithIdleTimeout()
				if (result.done) break
				const event = result.value
				try {
					switch (event.type) {
						case 'message_start': {
							if (event.message?.id) messageId = event.message.id
							if (event.message?.usage) {
								yield {
									id: messageId,
									delta: {},
									usage: parseUsage(event.message.usage),
								}
							}
							break
						}
						case 'content_block_start': {
							const idx = event.index ?? 0
							const block = event.content_block
							if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
								activeReasoning.add(idx)
								if (block.type === 'thinking') {
									nativeReasoning.set(idx, {
										type: 'thinking',
										thinking: block.thinking ?? '',
										signature: block.signature ?? '',
									})
								} else {
									nativeReasoning.set(idx, {
										type: 'redacted_thinking',
										data: block.data ?? '',
									})
								}
								yield {
									id: messageId,
									delta: {
										reasoning: {
											index: idx,
											type: block.type,
											...(block.data ? { encrypted: block.data } : {}),
										},
									},
								}
								break
							}
							if (block?.type === 'tool_use') {
								const toolId = block.id ?? `tool-${Date.now()}`
								activeTools.set(idx, { id: toolId, name: block.name ?? '' })
								yield {
									id: messageId,
									delta: {
										toolCalls: [
											{
												index: idx,
												id: toolId,
												type: 'function',
												function: { name: block.name ?? '' },
											},
										],
									},
								}
							}
							break
						}
						case 'content_block_delta': {
							const idx = event.index ?? 0
							const delta = event.delta
							if (delta?.type === 'text_delta' && delta.text) {
								yield { id: messageId, delta: { content: delta.text } }
							} else if (delta?.type === 'thinking_delta' && delta.thinking !== undefined) {
								const native = nativeReasoning.get(idx)
								if (native?.type === 'thinking') native.thinking += delta.thinking
								yield {
									id: messageId,
									delta: { reasoning: { index: idx, text: delta.thinking } },
								}
							} else if (delta?.type === 'signature_delta' && delta.signature !== undefined) {
								const native = nativeReasoning.get(idx)
								if (native?.type === 'thinking') native.signature += delta.signature
								// Arrives once, at the end of the block, and has to
								// reach the next request unmodified.
								yield {
									id: messageId,
									delta: {
										reasoning: { index: idx, signature: delta.signature },
									},
								}
							} else if (delta?.type === 'citations_delta' && delta.citation) {
								// Not text: a citation lands on the assistant
								// message beside the prose, which is where the
								// runtime's stream aggregator already puts it.
								const citation = toCitation(delta.citation, idx)
								if (citation) yield { id: messageId, delta: { citation } }
							} else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
								const active = activeTools.get(idx)
								yield {
									id: messageId,
									delta: {
										toolCalls: [
											{
												index: idx,
												id: active?.id,
												function: { arguments: delta.partial_json },
											},
										],
									},
								}
							}
							break
						}
						case 'content_block_stop': {
							// For tool_use blocks we MUST emit a `toolCallEnd`
							// signal so the consumer-side aggregator (sdk
							// runtime/query/iteration) can flush the buffered
							// `argsBuf` and JSON.parse it into the tool input.
							// Without this signal the executor sees an empty
							// `arguments` string and rejects the call with
							// `Error: Invalid JSON in tool arguments for "<tool>"`
							// — exactly the failure the live cowork test
							// surfaced (Bash + Write both blank-input failed).
							const idx = event.index ?? 0
							if (activeReasoning.delete(idx)) {
								// Closes the block, exactly as toolCallEnd closes a
								// tool call: without it the aggregator cannot know
								// the signature has finished arriving.
								yield {
									id: messageId,
									delta: { reasoning: { index: idx, done: true } },
								}
								break
							}
							const active = activeTools.get(idx)
							if (active) {
								yield {
									id: messageId,
									delta: {
										toolCallEnd: { index: idx, id: active.id },
									},
								}
								activeTools.delete(idx)
							}
							break
						}
						case 'message_delta': {
							if (event.delta?.stop_reason) {
								const replayState = completedReplayState()
								yield {
									id: messageId,
									...(replayState !== undefined ? { replayState } : {}),
									delta: {},
									finishReason: mapStopReason(event.delta.stop_reason),
									usage: event.usage ? parseUsage(event.usage) : undefined,
								}
							} else if (event.usage) {
								yield {
									id: messageId,
									delta: {},
									usage: parseUsage(event.usage),
								}
							}
							break
						}
						case 'message_stop': {
							const replayState = completedReplayState()
							if (replayState !== undefined) {
								yield { id: messageId, delta: {}, replayState }
							}
							return
						}
						default:
							// Ignore unknown / ping / opaque events.
							break
					}
				} catch (parseErr) {
					if (isProviderRequestError(parseErr)) throw parseErr
					throw new ProviderRequestError({
						kind: 'server',
						providerId: 'anthropic',
						detail: 'the provider stream returned malformed data',
					})
				}
			}
		} catch (err) {
			// A mid-stream failure arrives AFTER a 200, so the create-call wrap above
			// never sees it: the vendor SDK's SSE reader throws its own APIError for
			// an `event: error` frame, with the frame body as the message. Same
			// treatment — classify, then drop.
			//
			// An abort is NOT a provider failure: restore the caller's signal.reason
			// even when the SDK replaced it with its own APIUserAbortError object.
			if (isCallerAbortError(err, signal)) throw signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'anthropic', error: err })
		} finally {
			// Always release the underlying HTTP/2 connection — both on
			// idle-timeout rejection (bubbling up) and on normal stream
			// end (`message_stop` returned out of the loop). Leaving
			// the SSE connection open until OS-level timeout was the
			// gap Codex called out.
			await iter.return?.().catch(() => undefined)
		}
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		signal?.throwIfAborted()
		try {
			// Models API shipped in SDK ~0.32+. Feature-detect via unknown cast so we
			// don't depend on the SDK's surface-level shape in a version-brittle way.
			const clientLike = this.client as unknown as {
				models?: {
					list?: (opts: { limit: number }, request?: { signal?: AbortSignal }) => Promise<unknown>
				}
			}
			const models = clientLike.models
			if (typeof models?.list !== 'function') {
				return this.knownModels()
			}
			// Called ON the namespace, not pulled out and invoked bare. Detached,
			// it lost `this` and the SDK's own `this._client` read threw a
			// TypeError on EVERY call — which the catch below swallowed, so this
			// listing never once reached the network and the hardcoded models
			// were not a fallback but the only answer this method could give.
			const page = (await models.list({ limit: 100 }, signal ? { signal } : undefined)) as {
				data?: Array<{ id?: string; display_name?: string; type?: string }>
			}
			signal?.throwIfAborted()
			const data = page?.data ?? []
			if (data.length === 0) return this.knownModels()
			return data.map((m) => ({
				id: m.id ?? '',
				name: m.display_name ?? m.id ?? '',
				inputPrice: 0,
				outputPrice: 0,
				supportsToolUse: true,
				supportsStreaming: true,
			}))
		} catch {
			if (signal?.aborted) throw signal.reason
			return this.knownModels()
		}
	}

	/**
	 * Ask the API whether this credential works, and let the answer through.
	 *
	 * The same call `listModels` makes, without the `catch` that turns a real
	 * `401` into a hardcoded catalogue. That fallback is right for a menu and
	 * fatal for a probe: it reported an invalid key as working, because the
	 * failure it swallowed was the entire answer.
	 *
	 * An SDK too old to expose `models.list` throws rather than passing, so the
	 * caller reports unverifiable — nothing was asked, so nothing is known.
	 */
	async probeCredential(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()
		const clientLike = this.client as unknown as {
			models?: {
				list?: (opts: { limit: number }, request?: { signal?: AbortSignal }) => Promise<unknown>
			}
		}
		const models = clientLike.models
		if (typeof models?.list !== 'function') {
			throw new Error('This SDK version cannot list models, so the key cannot be checked here.')
		}
		// Called ON the namespace. Pulling the method into a bare variable and
		// invoking it loses `this`, and the SDK reads `this._client` — which is
		// how the sibling `listModels` came to never execute at all.
		await models.list({ limit: 1 }, signal ? { signal } : undefined)
		signal?.throwIfAborted()
	}

	private knownModels(): ModelInfo[] {
		// Copied, not handed out: the constant is shared and a caller that
		// sorted or spliced the returned array would edit the driver's menu.
		return [...OFFLINE_MODEL_CATALOGUE]
	}

	async healthCheck(): Promise<boolean> {
		// The client constructor validates the apiKey shape lazily. A no-op
		// check is sufficient here — a real request costs tokens. Callers that
		// want network-level verification should call `chat()` directly.
		return Boolean(this.client) && Boolean(this.config.apiKey)
	}

	/**
	 * The levels this model will accept, under the thinking configuration the
	 * caller intends to send.
	 *
	 * Deliberately built from the SAME two functions the request path uses —
	 * `resolveThinkingCapability` then `resolveThinkingBody` — rather than
	 * reading `capability.effort` directly. Reading the field would answer the
	 * question for adaptive thinking and silently give the wrong answer while
	 * thinking is disabled, which is precisely the trap this method exists to
	 * remove. Sharing the resolution means a caller's picker and the request
	 * it produces cannot disagree: if they ever do, they do so together, and
	 * the capability tests catch it.
	 */
	effortLevelsFor(model: string, thinking?: ThinkingConfig): readonly ReasoningEffort[] {
		const capability = resolveThinkingCapability(model)
		const body = resolveThinkingBody(thinking, capability)
		return body?.type === 'disabled' ? capability.effortWhenDisabled : capability.effort
	}

	reasoningEffortLevelsFor(model: string, thinking?: ThinkingConfig): readonly ReasoningEffort[] {
		return this.effortLevelsFor(model, thinking)
	}
}

/**
 * The menu this driver offers when the network cannot supply one.
 *
 * Module-level and exported so it can be READ without a client and without a
 * request. It was a literal inside a private method, which made the one
 * question worth asking of it unanswerable offline: does every model this
 * driver offers to an operator have a rate in `@namzu/sdk`'s price catalogue?
 *
 * It did not. Two of these three normalised to ids the catalogue had no row
 * for, so an operator who picked one off this menu got a run reporting its
 * cost as unknown — and, with a `costLimitUsd` set, a run refused outright.
 * That is a LOOKUP-KEY mismatch, and it is the failure the price catalogue's
 * own regeneration gate is structurally blind to: `--check` proves the
 * generated module is what its source produces, which says nothing about
 * whether the keys in it match what a driver actually reports. Only a test
 * that feeds real driver output through the real lookup can see it, and
 * `__tests__/pricing-conformance.test.ts` is that test.
 */
export const OFFLINE_MODEL_CATALOGUE: readonly ModelInfo[] = [
	{
		id: 'claude-sonnet-4-5-20250929',
		name: 'Claude Sonnet 4.5',
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		inputPrice: 3.0,
		outputPrice: 15.0,
		supportsToolUse: true,
		supportsStreaming: true,
	},
	{
		id: 'claude-opus-4-1-20250805',
		name: 'Claude Opus 4.1',
		contextWindow: 200_000,
		maxOutputTokens: 32_000,
		inputPrice: 15.0,
		outputPrice: 75.0,
		supportsToolUse: true,
		supportsStreaming: true,
	},
	{
		id: 'claude-haiku-4-5-20251001',
		name: 'Claude Haiku 4.5',
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		inputPrice: 1.0,
		outputPrice: 5.0,
		supportsToolUse: true,
		supportsStreaming: true,
	},
]
