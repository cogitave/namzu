import { describe, expect, it, vi } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import {
	type Message,
	createAssistantMessage,
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
	return new MockLLMProvider({ turns: [{ text: 'a summary of the earlier turns' }] })
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
	it('sheds messages and leaves a valid history behind', async () => {
		const messages = history(20)

		const result = await compactNow({ messages, config: config(), provider: provider() })

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
		const second = await compactNow({ messages: continued, config: config(), provider: provider() })
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
			compactRegion({ messages, start: 1, end: 3, config: config(), provider: provider() }),
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

	it('refuses a range that is not inside the history', async () => {
		const messages = history(4)

		await expect(
			compactRegion({ messages, start: 2, end: 999, config: config(), provider: provider() }),
		).rejects.toThrow(/not a range inside/)
	})

	it('returns null for an empty region rather than writing an empty summary', async () => {
		const messages = history(4)

		await expect(
			compactRegion({ messages, start: 2, end: 2, config: config(), provider: provider() }),
		).resolves.toBeNull()
	})
})
