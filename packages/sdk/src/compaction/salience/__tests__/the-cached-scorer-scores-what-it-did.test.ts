import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssistantMessage, Message, ToolMessage } from '../../../types/message/index.js'
import * as minhashModule from '../minhash.js'
import { scoreMessages } from '../score.js'
import * as tokenizer from '../tokenize.js'
import { planWorkingSet } from '../working-set.js'
import { referenceScoreMessages } from './reference-score.js'

/**
 * Per-message features (term frequencies, identifiers, signatures) are held
 * by message identity so a pass pays for the messages it has not seen. The
 * claim is "same output, less work", so both halves are pinned: the scores
 * and the messages the working set would choose are compared, number for
 * number, with the scorer as it was before the cache, on the same histories;
 * and the work is counted, for N messages and for 4N.
 *
 * The histories are short on purpose. The scorer as it was compares every
 * message with every earlier one, and this suite also runs under coverage on a
 * shared runner at about ten times the local cost; what decides a score is the
 * kind of message, not how many there are, and the last test of the first
 * group checks that every kind is reached.
 */

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		return state / 2 ** 32
	}
}

const VOCAB = [
	'src/store/session.ts',
	'removeTodo',
	'parseHTTPResponse',
	'namzu.turn.id',
	'the file',
	'error: ENOENT',
	'line',
	'value',
	'status ok',
	'packages/sdk/src/compaction/plan.ts',
	'retry',
	'config.softTarget',
	'ok',
	'build passed',
]

function sentence(next: () => number, words: number): string {
	let out = ''
	for (let i = 0; i < words; i += 1) out += `${VOCAB[Math.floor(next() * VOCAB.length)]} `
	return `${out.trim()}.`
}

function history(seed: number, turns: number): Message[] {
	const next = rng(seed)
	const messages: Message[] = [{ role: 'system', content: 'You are an agent.' }]
	let id = 0
	const repeatedCall = JSON.stringify({ command: 'true' })
	for (let t = 0; t < turns; t += 1) {
		const r = next()
		messages.push({
			role: 'user',
			content: r < 0.2 ? 'ok go on' : `turn ${t}: ${sentence(next, 3 + Math.floor(next() * 12))}`,
			...(next() < 0.04 ? { retain: true } : {}),
		})
		const calls = 1 + Math.floor(next() * 3)
		for (let c = 0; c < calls; c += 1) {
			const callId = `call_${++id}`
			const args = next() < 0.4 ? repeatedCall : JSON.stringify({ path: sentence(next, 2) })
			const call: AssistantMessage = {
				role: 'assistant',
				content: next() < 0.3 ? sentence(next, 4) : null,
				toolCalls: [{ id: callId, type: 'function', function: { name: 'bash', arguments: args } }],
			}
			messages.push(call)
			const kind = next()
			const text =
				kind < 0.15
					? ''
					: kind < 0.3
						? 'status ok'
						: kind < 0.4
							? `timestamp ${Math.floor(next() * 1000)} ${'status ok line value '.repeat(30)}`
							: sentence(next, 20 + Math.floor(next() * 200))
			const result: ToolMessage =
				kind > 0.93
					? {
							role: 'tool',
							toolCallId: callId,
							content: [
								{ type: 'text', text: sentence(next, 6) },
								{ type: 'image', data: 'AAAA', mediaType: 'image/png' },
							],
						}
					: {
							role: 'tool',
							toolCallId: callId,
							content: text,
							...(next() < 0.05 ? { isError: true } : {}),
						}
			messages.push(result)
		}
		const narration = next()
		messages.push({
			role: 'assistant',
			content:
				narration < 0.1
					? 'done.'
					: narration < 0.3
						? 'The build passed and the file is in place. '.repeat(8)
						: `${sentence(next, 40 + Math.floor(next() * 120))} step ${t}`,
		})
	}
	return messages
}

const goal = 'edit src/store/session.ts and keep config.softTarget readable'

/**
 * The twelve histories the comparison runs on, built once: the test that
 * checks they reach every kind of message reads the same objects, so it pays
 * for scoring them only when it runs alone.
 */
const compared = new Map<number, Message[]>()
function comparedHistory(seed: number): Message[] {
	let messages = compared.get(seed)
	if (messages === undefined) {
		messages = history(seed, 5 + seed)
		compared.set(seed, messages)
	}
	return messages
}

afterEach(() => vi.restoreAllMocks())

describe('the cached scorer', () => {
	it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
		'scores history %i as the uncached scorer did, and so does the working set built on it',
		(seed) => {
			const messages = comparedHistory(seed)
			for (const keepRecentMessages of [1, 6, 14]) {
				const expected = referenceScoreMessages(messages, { goal, keepRecentMessages })
				// First call fills the cache; the second reads it. Both must match.
				const first = scoreMessages(messages, { goal, keepRecentMessages })
				const second = scoreMessages(messages, { goal, keepRecentMessages })
				expect(first).toEqual(expected)
				expect(second).toEqual(expected)

				const options = { estimatedTokens: 50_000, targetTokens: 1_000, minToolResultChars: 300 }
				const oldPlan = planWorkingSet(messages, expected, options)
				const newPlan = planWorkingSet(messages, second, options)
				expect(newPlan.actions).toEqual(oldPlan.actions)
				expect(newPlan.messages).toEqual(oldPlan.messages)
				expect(newPlan.reclaimedTokens).toBe(oldPlan.reclaimedTokens)
			}
		},
	)

	it.each([0.3, 0.8, 1])(
		'scores as the uncached scorer did with a duplicate threshold of %s',
		(duplicateThreshold) => {
			for (const seed of [3, 8]) {
				const messages = history(seed, 14)
				const options = { goal, keepRecentMessages: 6, config: { duplicateThreshold } }
				expect(scoreMessages(messages, options)).toEqual(referenceScoreMessages(messages, options))
			}
		},
	)

	it('compares histories that reach every branch of the scorer', () => {
		const redundancy = new Set<string>()
		const utility = new Set<number>()
		const protectedBy = new Set<string | null>()
		for (let seed = 1; seed <= 12; seed += 1) {
			for (const s of scoreMessages(comparedHistory(seed), {
				goal,
				keepRecentMessages: 6,
			})) {
				redundancy.add(
					s.redundancy === 1
						? 'one'
						: s.redundancy === 0
							? 'zero'
							: s.redundancy >= 0.5
								? 'partial'
								: 'low',
				)
				utility.add(s.utility)
				protectedBy.add(s.protected)
			}
		}
		expect([...redundancy].sort()).toEqual(['one', 'partial', 'zero'])
		expect([...utility].sort()).toEqual([0, 0.2, 0.5, 1])
		expect([...protectedBy].sort()).toEqual(
			['pair', 'recent', 'retain', 'system-floor', null].sort(),
		)
	})

	it('keeps scoring as the uncached scorer does while the history grows and messages are replaced', () => {
		const grown: Message[] = []
		const full = history(21, 10)
		let stepped = 0
		for (const message of full) {
			grown.push(message)
			stepped += 1
			if (stepped % 7 !== 0) continue
			// A stub is a copy with different text, as the working set makes them.
			const target = grown.findIndex((m, i) => i > 0 && m.role === 'assistant' && m.content)
			if (target > 0 && typeof grown[target]?.content === 'string') {
				grown[target] = {
					...(grown[target] as AssistantMessage),
					content: 'cut. … (elided; 9 characters)',
				}
			}
			const options = { goal, keepRecentMessages: 6 }
			expect(scoreMessages(grown, options)).toEqual(referenceScoreMessages(grown, options))
		}
	})

	it('does not read a stale entry for a message whose text was edited in place', () => {
		const messages = history(33, 10)
		const target = messages.find(
			(m) => m.role === 'user' && typeof m.content === 'string',
		) as Message
		scoreMessages(messages, { goal, keepRecentMessages: 2 })
		;(target as { content: string }).content =
			'an entirely different instruction about src/store/session.ts'
		expect(scoreMessages(messages, { goal, keepRecentMessages: 2 })).toEqual(
			referenceScoreMessages(messages, { goal, keepRecentMessages: 2 }),
		)
	})

	it('tokenises and hashes each message once, however many passes score it', () => {
		const tokenize = vi.spyOn(tokenizer, 'tokenize')
		const minhash = vi.spyOn(minhashModule, 'minhash')
		const count = (turns: number) => {
			const messages = history(77 + turns, turns)
			tokenize.mockClear()
			minhash.mockClear()
			scoreMessages(messages, { goal, keepRecentMessages: 6 })
			const firstTokenize = tokenize.mock.calls.length
			const firstMinhash = minhash.mock.calls.length
			// Five more passes over the same history, and one with a message added.
			for (let pass = 0; pass < 5; pass += 1) {
				scoreMessages(messages, { goal, keepRecentMessages: 6 })
			}
			const repeatedTokenize = tokenize.mock.calls.length - firstTokenize
			const repeatedMinhash = minhash.mock.calls.length - firstMinhash
			return {
				messages: messages.length,
				firstTokenize,
				firstMinhash,
				repeatedTokenize,
				repeatedMinhash,
			}
		}
		const n = count(6)
		const fourN = count(24)
		// First sight of a history: one tokenisation per message and one for the goal.
		expect(n.firstTokenize).toBe(n.messages + 1)
		expect(fourN.firstTokenize).toBe(fourN.messages + 1)
		expect(n.firstMinhash).toBe(n.messages)
		expect(fourN.firstMinhash).toBe(fourN.messages)
		// A repeated pass only tokenises the goal; nothing grows with the history.
		expect(n.repeatedTokenize).toBe(5)
		expect(fourN.repeatedTokenize).toBe(5)
		expect(n.repeatedMinhash).toBe(0)
		expect(fourN.repeatedMinhash).toBe(0)
	})

	it('pays only for the messages added since the last pass', () => {
		const tokenize = vi.spyOn(tokenizer, 'tokenize')
		const minhash = vi.spyOn(minhashModule, 'minhash')
		for (const turns of [6, 24]) {
			const messages = history(5, turns + 3)
			const head = messages.slice(0, messages.length - 9)
			scoreMessages(head, { goal, keepRecentMessages: 6 })
			tokenize.mockClear()
			minhash.mockClear()
			scoreMessages(messages, { goal, keepRecentMessages: 6 })
			expect(minhash).toHaveBeenCalledTimes(9)
			expect(tokenize).toHaveBeenCalledTimes(9 + 1)
		}
	})
})
