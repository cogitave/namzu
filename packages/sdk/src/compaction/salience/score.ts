/**
 * Salience: how much the next step depends on each message.
 *
 * The compaction pass chose what to keep by position — the floor, the
 * last few turns, the last few tool results — and a fact stated in the
 * middle of a long turn aged out at the same rate as chatter. This gives
 * every message a number instead, from four things the kernel can
 * observe without a model:
 *
 *   recency     how many messages ago, decayed with a half-life;
 *   relevance   BM25 against the goal — the task, the requirements, the
 *               open plan items, the latest intent;
 *   utility     whether it was USED: a tool result whose paths and
 *               identifiers reappear in a later tool input or assistant
 *               turn; an instruction from the user;
 *   redundancy  whether a later message says the same thing — a repeated
 *               read, the same error twice — so the older copy yields.
 *
 * What no score may cross is stated as `protected`: the leading system
 * run, `retain` markers with the turn they pull in, the most recent
 * turns, and the other half of a tool-call pair. Pure, like `plan.ts`:
 * no turn, no logger, no provider, so it can be asked without one.
 */

import type { AssistantMessage, Message, ToolMessage } from '../../types/message/index.js'
import { findRetainedIndices } from '../retention.js'
import { estimateMessageTokens } from '../token-estimate.js'
import { type Bm25Document, bm25Score, buildIndex, indexDocument } from './bm25.js'
import { isEmptySignature, minhash, similarityAtLeast } from './minhash.js'
import { tokenize } from './tokenize.js'

export interface SalienceWeights {
	readonly recency: number
	readonly relevance: number
	readonly utility: number
	readonly redundancy: number
}

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
	recency: 1,
	relevance: 1,
	utility: 1,
	redundancy: 1,
}

export interface SalienceConfig {
	/** Messages after which recency has halved. */
	readonly halfLifeMessages: number
	/** Estimated Jaccard at or above which two messages are the same thing. */
	readonly duplicateThreshold: number
	readonly weights: SalienceWeights
}

export const DEFAULT_SALIENCE_CONFIG: SalienceConfig = {
	halfLifeMessages: 12,
	duplicateThreshold: 0.8,
	weights: DEFAULT_SALIENCE_WEIGHTS,
}

export type ProtectedReason = 'system-floor' | 'retain' | 'recent' | 'pair'

export interface ScoredMessage {
	readonly index: number
	readonly role: Message['role']
	/** Estimated tokens of the message, including rich content and tool inputs. */
	readonly tokens: number
	readonly recency: number
	readonly relevance: number
	readonly utility: number
	readonly redundancy: number
	/** The weighted sum; meaningful only relative to the other messages of the same pass. */
	readonly salience: number
	readonly protected: ProtectedReason | null
}

export interface ScoreOptions {
	/** The goal vector as text: task statement, requirements, open plan items, latest intent. */
	readonly goal: string
	/** How many trailing messages are protected as recent. */
	readonly keepRecentMessages: number
	readonly config?: Partial<SalienceConfig>
}

/** The model-visible text of a message, with an assistant's tool inputs. */
export function messageText(message: Message): string {
	if (message.role === 'tool') {
		return typeof message.content === 'string'
			? message.content
			: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
	}
	const parts: string[] = []
	if (typeof message.content === 'string') parts.push(message.content)
	if (message.role === 'assistant') {
		for (const call of (message as AssistantMessage).toolCalls ?? []) {
			parts.push(call.function.name, call.function.arguments)
		}
	}
	return parts.join('\n')
}

function hasRichContent(message: Message): boolean {
	return (
		(message.role === 'user' && (message.attachments?.length ?? 0) > 0) ||
		(message.role === 'tool' &&
			typeof message.content !== 'string' &&
			message.content.some((block) => block.type !== 'text'))
	)
}

const isAssistantWithCalls = (m: Message): m is AssistantMessage =>
	m.role === 'assistant' && Array.isArray((m as AssistantMessage).toolCalls)

/** Tokens that look like something a later turn could cite: paths, identifiers, dotted keys. */
function citable(tokens: readonly string[]): Set<string> {
	const out = new Set<string>()
	for (const token of tokens) {
		if (token.length >= 5 || token.includes('/') || token.includes('.')) out.add(token)
	}
	return out
}

/**
 * What the scorer derives from one message's text, and nothing that depends
 * on the rest of the history: the term frequencies BM25 reads, the
 * identifiers a later turn could cite, the MinHash signature and a key for
 * "byte-identical signature".
 *
 * A pass scored every message from its raw text every time, and the text of
 * a message that is already in the history does not change between passes.
 * The cost of a pass was therefore proportional to every byte in the
 * history, paid again on each pass, and the largest part of it was hashing
 * shingles. Held per message OBJECT, a pass pays for the messages it has not
 * seen and for the arithmetic that does depend on the whole history (the
 * corpus statistics, recency, the redundancy comparison).
 *
 * Keyed by object identity and validated by the text it was computed from: a
 * message that is replaced (a stub is a copy) is a different object, and one
 * that is edited in place fails the text comparison, so a stale entry is
 * never read. Weakly held: an entry goes with its message.
 */
interface MessageFeatures {
	readonly text: string
	readonly tokenCount: number
	readonly document: Bm25Document
	readonly citable: ReadonlySet<string>
	readonly signature: Uint32Array
	/** Equal keys mean equal signatures, so a similarity of exactly 1. */
	readonly signatureKey: string
}

const FEATURES = new WeakMap<Message, MessageFeatures>()

function featuresOf(message: Message, text: string): MessageFeatures {
	const cached = FEATURES.get(message)
	if (cached !== undefined && cached.text === text) return cached
	const tokens = tokenize(text)
	const signature = minhash(tokens)
	const features: MessageFeatures = {
		text,
		tokenCount: tokens.length,
		document: indexDocument(text, tokens),
		citable: citable(tokens),
		signature,
		signatureKey: String.fromCharCode(...new Uint16Array(signature.buffer)),
	}
	FEATURES.set(message, features)
	return features
}

export function scoreMessages(
	messages: readonly Message[],
	options: ScoreOptions,
): ScoredMessage[] {
	const config: SalienceConfig = {
		...DEFAULT_SALIENCE_CONFIG,
		...options.config,
		weights: { ...DEFAULT_SALIENCE_WEIGHTS, ...options.config?.weights },
	}
	const n = messages.length
	const features = messages.map((message) => featuresOf(message, messageText(message)))
	const richContent = messages.map(hasRichContent)
	const documents: Bm25Document[] = features.map((f) => f.document)
	const index = buildIndex(documents)
	const goalTokens = tokenize(options.goal)

	// Relevance, normalised to the best message of the pass so weights mean
	// the same thing in a short run and a long one.
	// Normalised to the best message the pass could evict, not to the user
	// turn that stated the goal: that turn matches the goal by definition,
	// and measured against it every result reads as barely relevant.
	const rawRelevance = documents.map((doc) => bm25Score(index, doc, goalTokens))
	// Nor to an assistant turn that only issued a call: its arguments echo
	// the goal's path in a dozen tokens, which BM25 scores above the
	// four-thousand-token result that actually holds the file.
	const maxRelevance = Math.max(
		0,
		...rawRelevance.filter((_, i) => {
			const m = messages[i] as Message
			return m.role === 'tool' || (m.role === 'assistant' && !isAssistantWithCalls(m))
		}),
	)

	// Citation index: everything a LATER assistant turn or tool input names.
	// For each identifier, the last message that names it: a message asks
	// "does anything after me cite my identifiers" as "is the last citation
	// of this identifier after me". The same answer as a set of everything
	// after each message, without building n sets of up to n identifiers.
	const lastCited = new Map<string, number>()
	for (let i = 0; i < n; i += 1) {
		const message = messages[i] as Message
		if (message.role !== 'assistant' && message.role !== 'user') continue
		for (const token of (features[i] as MessageFeatures).citable) lastCited.set(token, i)
	}

	// A full demotion when a later assistant turn repeats this message's
	// tool call exactly: for each call, the last message that makes it.
	const callKeys = messages.map((m) =>
		isAssistantWithCalls(m)
			? (m.toolCalls ?? []).map((c) => `${c.function.name}:${c.function.arguments}`)
			: [],
	)
	const lastCalled = new Map<string, number>()
	for (let i = 0; i < n; i += 1) {
		for (const key of callKeys[i] as string[]) lastCalled.set(key, i)
	}

	// Redundancy: the highest similarity to any later message of the same
	// role. Walked from the end so the later messages of each role are the
	// ones already seen; a signature identical to one of them is a
	// similarity of exactly 1, the most there is, and ends the scan.
	// Below the lower of one half and the duplicate threshold a similarity
	// is read as none (see the redundancy step of the score), so the
	// comparison need not finish it.
	const floor = Math.min(0.5, config.duplicateThreshold)
	const redundancyOf: number[] = new Array(n).fill(0)
	const laterSignatures = new Map<Message['role'], Uint32Array[]>()
	const laterKeys = new Map<Message['role'], Set<string>>()
	for (let i = n - 1; i >= 0; i -= 1) {
		const message = messages[i] as Message
		// A caption or a repeated call cannot prove that two screenshots or
		// documents contain the same evidence. The lexical scorer has no
		// access to their meaning, so it must not call those messages duplicates.
		if (richContent[i]) continue
		const own = features[i] as MessageFeatures
		const sameRole = laterSignatures.get(message.role) ?? []
		const sameRoleKeys = laterKeys.get(message.role) ?? new Set<string>()
		let redundancy = 0
		if (!isEmptySignature(own.signature)) {
			if (sameRoleKeys.has(own.signatureKey)) redundancy = 1
			else {
				for (const other of sameRole) {
					const sim = similarityAtLeast(own.signature, other, floor)
					if (sim > redundancy) redundancy = sim
				}
			}
		}
		redundancyOf[i] = redundancy
		sameRole.push(own.signature)
		sameRoleKeys.add(own.signatureKey)
		laterSignatures.set(message.role, sameRole)
		laterKeys.set(message.role, sameRoleKeys)
	}

	// Protection.
	const protectedBy: (ProtectedReason | null)[] = new Array(n).fill(null)
	let floorEnd = 0
	while (floorEnd < n && messages[floorEnd]?.role === 'system') {
		protectedBy[floorEnd] = 'system-floor'
		floorEnd += 1
	}
	for (const i of findRetainedIndices(messages))
		if (protectedBy[i] === null) protectedBy[i] = 'retain'
	for (let i = Math.max(floorEnd, n - options.keepRecentMessages); i < n; i += 1) {
		if (protectedBy[i] === null) protectedBy[i] = 'recent'
	}
	// A protected half of a pair protects the other half.
	for (let i = 0; i < n; i += 1) {
		const message = messages[i] as Message
		if (!isAssistantWithCalls(message) || protectedBy[i] === null) continue
		const ids = new Set((message.toolCalls ?? []).map((c) => c.id))
		for (let j = i + 1; j < n && ids.size > 0; j += 1) {
			const candidate = messages[j] as Message
			if (candidate.role !== 'tool') {
				if (candidate.role === 'assistant') break
				continue
			}
			if (ids.has((candidate as ToolMessage).toolCallId)) {
				ids.delete((candidate as ToolMessage).toolCallId)
				if (protectedBy[j] === null) protectedBy[j] = 'pair'
			}
		}
	}
	for (let j = n - 1; j >= 0; j -= 1) {
		const message = messages[j] as Message
		if (message.role !== 'tool' || protectedBy[j] === null) continue
		const id = (message as ToolMessage).toolCallId
		for (let i = j - 1; i >= 0; i -= 1) {
			const candidate = messages[i] as Message
			if (isAssistantWithCalls(candidate) && (candidate.toolCalls ?? []).some((c) => c.id === id)) {
				if (protectedBy[i] === null) protectedBy[i] = 'pair'
				break
			}
		}
	}

	const scored: ScoredMessage[] = []
	for (let i = 0; i < n; i += 1) {
		const message = messages[i] as Message
		const distance = n - 1 - i
		const recency = 2 ** (-distance / Math.max(1, config.halfLifeMessages))
		const relevance = maxRelevance > 0 ? (rawRelevance[i] as number) / maxRelevance : 0

		let utility = 0
		if (message.role === 'user') {
			// An instruction is used by everything after it; an acknowledgment
			// ("ok, go on") is not an instruction. The difference is whether it
			// names anything or says more than a few words.
			const own = features[i] as MessageFeatures
			utility = own.citable.size > 0 || own.tokenCount >= 6 ? 1 : 0.2
		} else if (message.role === 'tool') {
			// Used is used: one identifier from this result named by a later
			// turn is the evidence, and a count would let the recency of
			// everything after it outvote the one result the turn came back
			// for. The eval that placed the account id deep in an early dump
			// and cited it later watched the salience pass clear it under a
			// thirds rule.
			let cited = false
			for (const token of (features[i] as MessageFeatures).citable) {
				if ((lastCited.get(token) ?? -1) > i) {
					cited = true
					break
				}
			}
			utility = cited ? 1 : 0
		} else if (isAssistantWithCalls(message)) utility = 0.5

		let redundancy = redundancyOf[i] as number
		if (redundancy < config.duplicateThreshold) redundancy = redundancy >= 0.5 ? redundancy : 0
		else redundancy = 1
		if (message.role === 'tool' && !richContent[i]) {
			// The result of a call a later turn repeats exactly: the newer
			// result is the one that counts.
			for (let k = i - 1; k >= 0; k -= 1) {
				const producer = messages[k] as Message
				if (!isAssistantWithCalls(producer)) continue
				const call = (producer.toolCalls ?? []).find(
					(c) => c.id === (message as ToolMessage).toolCallId,
				)
				if (call) {
					const key = `${call.function.name}:${call.function.arguments}`
					if ((lastCalled.get(key) ?? -1) > i) redundancy = 1
					break
				}
			}
		}

		const w = config.weights
		const salience =
			w.recency * recency +
			w.relevance * relevance +
			w.utility * utility -
			w.redundancy * redundancy
		scored.push({
			index: i,
			role: message.role,
			tokens: estimateMessageTokens(message),
			recency,
			relevance,
			utility,
			redundancy,
			salience,
			protected: protectedBy[i] as ProtectedReason | null,
		})
	}
	return scored
}
