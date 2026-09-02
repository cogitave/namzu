/**
 * Salience: how much the next step depends on each message.
 *
 * The compaction pass chose what to keep by position — the floor, the
 * last few turns, the last few tool results — and a fact stated in the
 * middle of a long run aged out at the same rate as chatter. This gives
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
 * no run, no logger, no provider, so it can be asked without one.
 */

import { CHARS_PER_TOKEN } from '../../constants/limits.js'
import { toolResultToText } from '../../types/message/content.js'
import type { AssistantMessage, Message, ToolMessage } from '../../types/message/index.js'
import { findRetainedIndices } from '../retention.js'
import { type Bm25Document, bm25Score, buildIndex, indexDocument } from './bm25.js'
import { isEmptySignature, minhash, similarity } from './minhash.js'
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
	/** Estimated tokens of the message's model-visible text. */
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
	if (message.role === 'tool') return toolResultToText((message as ToolMessage).content)
	const parts: string[] = []
	if (typeof message.content === 'string') parts.push(message.content)
	if (message.role === 'assistant') {
		for (const call of (message as AssistantMessage).toolCalls ?? []) {
			parts.push(call.function.name, call.function.arguments)
		}
	}
	return parts.join('\n')
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
	const texts = messages.map(messageText)
	const tokenLists = texts.map(tokenize)
	const documents: Bm25Document[] = texts.map(indexDocument)
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
	// Built once, suffix-wise, so each message asks "does anything after me
	// cite my identifiers" in one lookup.
	const citedAfter: Set<string>[] = new Array(n)
	let running = new Set<string>()
	for (let i = n - 1; i >= 0; i -= 1) {
		citedAfter[i] = running
		const message = messages[i] as Message
		if (message.role === 'assistant' || message.role === 'user') {
			running = new Set([...running, ...citable(tokenLists[i] as string[])])
		}
	}

	// Redundancy: the highest similarity to any later message of the same
	// role, and a full demotion when a later assistant turn repeats this
	// message's tool call exactly.
	const signatures = tokenLists.map(minhash)
	const callKeys = messages.map((m) =>
		isAssistantWithCalls(m)
			? (m.toolCalls ?? []).map((c) => `${c.function.name}:${c.function.arguments}`)
			: [],
	)
	const laterCallKeys: Set<string>[] = new Array(n)
	let calls = new Set<string>()
	for (let i = n - 1; i >= 0; i -= 1) {
		laterCallKeys[i] = calls
		if ((callKeys[i] as string[]).length > 0)
			calls = new Set([...calls, ...(callKeys[i] as string[])])
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
			const tokens = tokenLists[i] as string[]
			utility = citable(tokens).size > 0 || tokens.length >= 6 ? 1 : 0.2
		} else if (message.role === 'tool') {
			// Used is used: one identifier from this result named by a later
			// turn is the evidence, and a count would let the recency of
			// everything after it outvote the one result the run came back
			// for. The eval that placed the account id deep in an early dump
			// and cited it later watched the salience pass clear it under a
			// thirds rule.
			const mine = citable(tokenLists[i] as string[])
			let hits = 0
			for (const token of mine) if ((citedAfter[i] as Set<string>).has(token)) hits += 1
			utility = hits > 0 ? 1 : 0
		} else if (isAssistantWithCalls(message)) utility = 0.5

		let redundancy = 0
		const signature = signatures[i] as Uint32Array
		if (!isEmptySignature(signature)) {
			for (let j = i + 1; j < n; j += 1) {
				if ((messages[j] as Message).role !== message.role) continue
				const sim = similarity(signature, signatures[j] as Uint32Array)
				if (sim > redundancy) redundancy = sim
			}
		}
		if (redundancy < config.duplicateThreshold) redundancy = redundancy >= 0.5 ? redundancy : 0
		else redundancy = 1
		if (message.role === 'tool') {
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
					if ((laterCallKeys[i] as Set<string>).has(key)) redundancy = 1
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
			tokens: Math.ceil((texts[i] as string).length / CHARS_PER_TOKEN),
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
