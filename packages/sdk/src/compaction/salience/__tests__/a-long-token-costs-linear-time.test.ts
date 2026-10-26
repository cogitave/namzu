import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../types/message/index.js'
import { scoreMessages } from '../score.js'
import * as tokenizer from '../tokenize.js'
import { tokenize } from '../tokenize.js'

describe('a very long unbroken token', () => {
	it('is tokenized without backtracking over its capitals', () => {
		// A quadratic split takes minutes here; the runner's own timeout catches a regression.
		const run = 'A'.repeat(400_000)
		expect(tokenize(run)).toEqual([run.toLowerCase()])
	})

	it.each(['-', '.', '/'])('trims a long run of %s inside a token in linear time', (sep) => {
		// A quadratic end-trim takes tens of seconds here; the runner's own timeout catches a regression.
		const token = `x${sep.repeat(400_000)}x`
		expect(tokenize(token)[0]).toBe(token)
	})

	it('trims separators from both ends of a token', () => {
		expect(tokenize('--./foo.bar:/')).toEqual(['foo.bar', 'foo', 'bar'])
	})

	it('still splits an acronym from the word after it', () => {
		expect(tokenize('parseHTTPResponse')).toEqual([
			'parsehttpresponse',
			'parse',
			'http',
			'response',
		])
	})

	it('is tokenized once per message when scoring', () => {
		const spy = vi.spyOn(tokenizer, 'tokenize')
		const messages: Message[] = [
			{ role: 'system', content: 'sys' },
			...Array.from({ length: 6 }, (_, i) => ({
				role: 'user' as const,
				content: `${'B'.repeat(200_000)} ${i}`,
			})),
		]
		scoreMessages(messages, { goal: 'x', keepRecentMessages: 1 } as never)
		// one pass over the messages plus one for the goal
		expect(spy).toHaveBeenCalledTimes(messages.length + 1)
		spy.mockRestore()
	})
})
