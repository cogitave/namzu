import { describe, expect, it } from 'vitest'

import { SPILL_MARKER } from '../../runtime/query/tool-output-budget.js'
import type { Message } from '../../types/message/index.js'
import { clearStaleToolResults, isClearedToolResult } from '../tool-result-editing.js'

/**
 * Clearing replaced the whole content with a placeholder, which destroyed
 * the recovery pointer for exactly the results that most needed one.
 *
 * When a tool result exceeds the output budget its full text is written to
 * disk and a line pointing at it is embedded IN the result. Clearing that
 * result deleted the line — so the largest outputs lost the cheapest way
 * back to them, and the placeholder then advised calling the tool again,
 * which is advice to re-run something that returned megabytes.
 */

function history(resultText: string): Message[] {
	return [
		{ role: 'user', content: 'go' },
		{
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
		},
		{ role: 'tool', toolCallId: 'c1', content: resultText },
		{ role: 'user', content: 'next' },
	] as Message[]
}

const clear = (messages: Message[]) =>
	clearStaleToolResults(messages, { keepRecentToolResults: 0, minCharsToClear: 100 })

const clearedText = (messages: Message[]): string => {
	const tool = messages.find((m) => m.role === 'tool')
	return String((tool as { content: string }).content)
}

describe('a spilled result', () => {
	// The marker sits in the MIDDLE, outside both the head and the tail
	// window. Left near the end it would ride along in the tail and the
	// test would pass with the preservation removed.
	const spilled = [
		'first line of output',
		'x'.repeat(5_000),
		`${SPILL_MARKER} /runs/r1/tool-output/bash-1.txt`,
		'Read a specific window with `read` (offset/limit) or search it with `grep`.',
		'y'.repeat(5_000),
	].join('\n')

	it('keeps the pointer to the spilled file', () => {
		const { messages } = clear(history(spilled))
		// The line is the only route back to content the budget
		// deliberately preserved on disk.
		expect(clearedText(messages)).toContain('/runs/r1/tool-output/bash-1.txt')
	})

	it('tells the model to read it rather than re-run the tool', () => {
		const { messages } = clear(history(spilled))
		const text = clearedText(messages)
		expect(text).toMatch(/read|grep/)
		// Re-running a tool that returned megabytes is the advice this
		// replaces.
		expect(text).not.toContain('Call the tool again')
	})

	it('still reclaims most of the content', () => {
		const { charsReclaimed, clearedCount } = clear(history(spilled))
		expect(clearedCount).toBe(1)
		expect(charsReclaimed).toBeGreaterThan(4_000)
	})
})

describe('an ordinary large result', () => {
	const long = `HEAD-MARKER\n${'y'.repeat(5_000)}\nTAIL-MARKER`

	it('keeps a readable head and tail', () => {
		const text = clearedText(clear(history(long)).messages)
		// A result is not uniformly valuable; what a model needs is usually
		// near one end.
		expect(text).toContain('HEAD-MARKER')
		expect(text).toContain('TAIL-MARKER')
	})

	it('says how much it elided', () => {
		expect(clearedText(clear(history(long)).messages)).toMatch(/characters elided/)
	})

	it('still advises re-running when there is nothing on disk', () => {
		expect(clearedText(clear(history(long)).messages)).toContain('Call the tool again')
	})

	it('is still recognisable as cleared', () => {
		// A second pass must not clear its own placeholder again.
		const once = clear(history(long)).messages
		expect(isClearedToolResult(clearedText(once))).toBe(true)
		expect(clear(once).clearedCount).toBe(0)
	})

	it('reclaims more than it keeps', () => {
		const { charsReclaimed } = clear(history(long))
		expect(charsReclaimed).toBeGreaterThan(3_000)
	})
})

describe('a result barely over the threshold', () => {
	it('does not lose everything to save a few hundred characters', () => {
		const short = `IMPORTANT-FIRST-LINE\n${'z'.repeat(200)}\nIMPORTANT-LAST-LINE`
		const { messages } = clearStaleToolResults(history(short), {
			keepRecentToolResults: 0,
			minCharsToClear: 100,
		})
		const text = clearedText(messages)
		// The three lines the agent was reasoning from used to go with it.
		expect(text).toContain('IMPORTANT-FIRST-LINE')
		expect(text).toContain('IMPORTANT-LAST-LINE')
	})
})
