import { describe, expect, it, vi } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import {
	type Message,
	createAssistantMessage,
	createProjectInstructionMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import { findDanglingMessages } from '../dangling.js'
import { compactNow, compactRegion } from '../manual.js'

/**
 * "Compact this conversation" as something a host can ask for.
 *
 * `runCompactionCheck` was the only entry point in the kernel and it was
 * exported from nowhere — not from the compaction barrel and not from the
 * package root. Every compaction had to wait for the in-loop threshold or
 * for a provider to reject an overlong prompt, so a host could not shrink
 * an idle session between turns and could not collapse a span it chose.
 */

const config = (over: Partial<CompactionConfig> = {}): CompactionConfig =>
	({
		strategy: 'structured',
		triggerThreshold: 0.7,
		keepRecentMessages: 4,
		clearToolResults: false,
		richStateThreshold: 100,
		llmVerification: false,
		maxCharsPerTask: 2_000,
		...over,
	}) as CompactionConfig

function provider(): LLMProvider {
	return new MockLLMProvider({
		turns: [{ text: 'a summary of the earlier turns' }],
	})
}

function history(turns: number): Message[] {
	const out: Message[] = [createSystemMessage('you are a helper')]
	for (let i = 0; i < turns; i++) {
		out.push(createUserMessage(`question ${i}`))
		out.push(createAssistantMessage(`answer ${i}`))
	}
	return out
}

/** An assistant turn that called one tool, and the result answering it. */
function callPair(id: string): Message[] {
	return [
		createAssistantMessage('', [
			{ id, type: 'function', function: { name: 'probe', arguments: '{}' } },
		]),
		createToolMessage('output', id),
	]
}

describe('a host can ask for compaction', () => {
	it('compacts the user/assistant-only history a host actually persists', async () => {
		const messages = history(5).filter((message) => message.role !== 'system')

		const result = await compactNow({
			messages,
			config: config(),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		expect(result.messages[0]).toEqual(result.summary)
		expect(result.summary.role).toBe('system')
		expect(result.summary.retain).toBe(true)
		expect(String(result.summary.content)).toContain('question 0')
		expect(result.shed).toBe(messages.length - result.messages.length)
		expect(result.shed).toBeGreaterThan(0)
		expect(result.usage).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		})
	})

	it.each(['whole history', 'selected region'] as const)(
		'reports verifier usage for %s compaction',
		async (mode) => {
			const spent = {
				promptTokens: 1_200,
				completionTokens: 35,
				totalTokens: 1_235,
				cachedTokens: 400,
				cacheWriteTokens: 12,
			}
			const p = new MockLLMProvider({ turns: [{ text: 'COMPLETE', usage: spent }] })
			const messages = history(8)
			const verification = config({
				llmVerification: true,
				llmVerificationMaxTokens: 128,
				convoTextBudget: 4_000,
			})

			const result =
				mode === 'whole history'
					? await compactNow({ messages, config: verification, provider: p, model: 'mock-model' })
					: await compactRegion({
							messages,
							start: 1,
							end: 7,
							config: verification,
							provider: p,
							model: 'mock-model',
						})

			expect(result).not.toBeNull()
			expect(result?.usage).toEqual(spent)
			expect(p.requests).toHaveLength(1)
		},
	)

	it('uses the token boundary rather than an inactive message-count minimum', async () => {
		const messages = Array.from({ length: 4 }, (_, index) =>
			createUserMessage(`turn ${index}: ${'large '.repeat(100)}`),
		)
		const tail = messages.at(-1)

		const result = await compactNow({
			messages,
			config: config({ keepRecentMessages: 100, keepRecentTokens: 160 }),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		expect(result.messages.at(-1)).toEqual(tail)
		expect(result.messages.filter((message) => message === tail)).toHaveLength(1)
		expect(result.shed).toBeGreaterThan(0)
	})

	it('sheds messages and leaves a valid history behind', async () => {
		const messages = history(20)

		const result = await compactNow({
			messages,
			config: config(),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		expect(result.messages.length).toBeLessThan(messages.length)
		expect(result.shed).toBeGreaterThan(0)
		// The property that matters most and is easiest to lose: a history
		// with a `tool_result` whose `tool_use` was summarised away is
		// rejected by the provider on the very next turn.
		expect(findDanglingMessages([...result.messages]).isValid).toBe(true)
		expect(String(result.summary.content)).toContain('[COMPACTED CONTEXT]')
		expect(
			String(result.summary.content),
			'the summary header survived but the history it claimed to summarize did not',
		).toContain('question 0')
		expect(result.summary.retain).toBe(true)
	})

	it('keeps an earlier host-triggered summary when compacting again', async () => {
		const first = await compactNow({
			messages: history(20),
			config: config(),
			provider: provider(),
		})
		expect(first).not.toBeNull()
		if (!first) return

		const continued = [
			...first.messages,
			...history(8).filter((message) => message.role !== 'system'),
		]
		const second = await compactNow({
			messages: continued,
			config: config(),
			provider: provider(),
		})
		expect(second).not.toBeNull()
		if (!second) return

		expect(
			second.messages.some((message) => message.content === first.summary.content),
			'a later manual pass erased the only surviving account of the first pass',
		).toBe(true)
	})

	it('returns null on a history too short to shed, without calling the provider', async () => {
		// Not a zero-shed result. A caller has to be able to tell "I compacted
		// and it did nothing" from "I compacted", and an outcome object
		// reporting zero is the shape that gets logged as a successful pass
		// and shown to a user as work done.
		const p = provider()
		const spy = vi.spyOn(p, 'chatStream')

		const result = await compactNow({
			messages: [createSystemMessage('s'), createUserMessage('one')],
			config: config(),
			provider: p,
		})

		expect(result).toBeNull()
		expect(spy).not.toHaveBeenCalled()
	})

	it('does not touch the array it was given', async () => {
		// There is no run here. The array belongs to the host, and editing it
		// in place is the difference between a function and a side effect —
		// the in-loop path writes to the live array on purpose, this one must
		// not.
		const messages = history(20)
		const before = structuredClone(messages)

		await compactNow({ messages, config: config(), provider: provider() })

		expect(messages).toEqual(before)
	})

	it('keeps a pinned older user message byte-for-byte instead of paraphrasing it away', async () => {
		const messages = history(8)
		const pinned: Message = {
			...createUserMessage('the exact account instruction', [
				{ data: 'aW1hZ2UtYnl0ZXM=', mediaType: 'image/png' },
			]),
			cacheHint: 'cache',
			retain: true,
		}
		messages[1] = pinned
		const before = structuredClone(messages)

		const result = await compactNow({
			messages,
			config: config(),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		const summaryIndex = result.messages.indexOf(result.summary)
		const pinnedIndex = result.messages.findIndex((message) => message === pinned)
		expect(pinnedIndex).toBeGreaterThan(summaryIndex)
		expect(result.messages[pinnedIndex]).toEqual(pinned)
		expect(messages).toEqual(before)
		expect(result.shed).toBe(messages.length - result.messages.length)
	})

	it('keeps exactly one live project-policy snapshot byte-for-byte', async () => {
		const policy = createProjectInstructionMessage('exact nested policy', [
			'AGENTS.md',
			'packages/a/AGENTS.md',
		])
		const messages = history(8)
		messages[1] = policy
		const before = structuredClone(messages)

		const result = await compactNow({
			messages,
			config: config(),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		const snapshots = result.messages.filter(
			(message) => message.role === 'user' && message.source?.type === 'project-instructions',
		)
		expect(snapshots).toEqual([policy])
		expect(messages).toEqual(before)
	})

	it('keeps the whole pinned tool exchange in the older window', async () => {
		const pair = callPair('pinned-tool')
		const turnUser = createUserMessage('run the pinned probe')
		const pinnedResult = { ...pair[1], retain: true }
		const messages: Message[] = [
			createSystemMessage('s'),
			turnUser,
			pair[0] as Message,
			pinnedResult as Message,
			createUserMessage('discard one'),
			createAssistantMessage('discard two'),
			createUserMessage('recent one'),
			createAssistantMessage('recent two'),
		]

		const result = await compactNow({
			messages,
			config: config({ keepRecentMessages: 2 }),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		const summaryIndex = result.messages.indexOf(result.summary)
		const preserved = result.messages.slice(summaryIndex + 1, summaryIndex + 4)
		expect(preserved).toEqual([turnUser, pair[0], pinnedResult])
		expect(result.messages.find((message) => message.role !== 'system')?.role).toBe('user')
		expect(findDanglingMessages([...result.messages]).isValid).toBe(true)
	})

	it('returns null before summary work when every older message must survive', async () => {
		const p = provider()
		const spy = vi.spyOn(p, 'chatStream')
		const messages: Message[] = [
			{ ...createUserMessage('pinned older'), retain: true },
			createUserMessage('recent one'),
			createAssistantMessage('recent two'),
		]

		await expect(
			compactNow({
				messages,
				config: config({ keepRecentMessages: 2, llmVerification: true }),
				provider: p,
			}),
		).resolves.toBeNull()
		expect(spy).not.toHaveBeenCalled()
	})

	it('refuses a region whose edge splits a tool pair, naming the index', async () => {
		// Snapping the edge to the nearest safe one would summarise a
		// DIFFERENT span than the caller asked for, and they picked those
		// indices from something they were looking at — the result would be a
		// valid history that compacted the wrong messages, with nothing to
		// notice.
		const messages: Message[] = [
			createSystemMessage('s'),
			createUserMessage('go'),
			...callPair('t1'),
			createAssistantMessage('done'),
			createUserMessage('next'),
		]
		// Index 3 sits between the assistant's tool_use and its tool_result.
		await expect(
			compactRegion({
				messages,
				start: 1,
				end: 3,
				config: config(),
				provider: provider(),
			}),
		).rejects.toThrow(/end index 3/)
	})

	it('compacts exactly the span it was given', async () => {
		const messages = history(10)
		const originalLength = messages.length

		const result = await compactRegion({
			messages,
			start: 1,
			end: 5,
			config: config(),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		// Four messages replaced by one.
		expect(result.messages).toHaveLength(originalLength - 3)
		expect(result.messages[0]).toEqual(messages[0])
		expect(String(result.messages[1]?.content)).toContain('[COMPACTED CONTEXT]')
		expect(String(result.messages[1]?.content)).toContain('question 0')
		expect(result.summary.retain).toBe(true)
		expect(result.messages[2]).toEqual(messages[5])
	})

	it('preserves pinned messages and their tool pair inside an exact region', async () => {
		const pair = callPair('region-tool')
		const turnUser = createUserMessage('regional invariant')
		const pinnedTool = { ...pair[1], retain: true }
		const messages: Message[] = [
			createSystemMessage('s'),
			turnUser,
			pair[0] as Message,
			pinnedTool as Message,
			createUserMessage('discard A'),
			createAssistantMessage('discard B'),
			createUserMessage('after region'),
		]

		const result = await compactRegion({
			messages,
			start: 1,
			end: 6,
			config: config(),
			provider: provider(),
		})

		expect(result).not.toBeNull()
		if (!result) return
		expect(result.messages.slice(2, 5)).toEqual([turnUser, pair[0], pinnedTool])
		expect(result.messages.find((message) => message.role !== 'system')?.role).toBe('user')
		expect(result.messages[5]).toEqual(messages[6])
		expect(result.shed).toBe(messages.length - result.messages.length)
		expect(result.shed).toBe(1)
		expect(findDanglingMessages([...result.messages]).isValid).toBe(true)
	})

	it('returns null before provider work when a region has no net shed', async () => {
		const p = provider()
		const spy = vi.spyOn(p, 'chatStream')
		const messages = [
			createSystemMessage('s'),
			{ ...createUserMessage('pinned'), retain: true },
			createAssistantMessage('replaceable'),
			createUserMessage('after'),
		]

		await expect(
			compactRegion({
				messages,
				start: 1,
				end: 3,
				config: config({ llmVerification: true }),
				provider: p,
			}),
		).resolves.toBeNull()
		expect(spy).not.toHaveBeenCalled()
	})

	it('refuses a range that is not inside the history', async () => {
		const messages = history(4)

		await expect(
			compactRegion({
				messages,
				start: 2,
				end: 999,
				config: config(),
				provider: provider(),
			}),
		).rejects.toThrow(/not a range inside/)
	})

	it('returns null for an empty region rather than writing an empty summary', async () => {
		const messages = history(4)

		await expect(
			compactRegion({
				messages,
				start: 2,
				end: 2,
				config: config(),
				provider: provider(),
			}),
		).resolves.toBeNull()
	})
})
