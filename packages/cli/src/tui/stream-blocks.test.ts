import { describe, expect, it } from 'vitest'

import { splitCompleteBlocks, splitSafeCut } from './stream-blocks.js'

/** Feed a string in one-character deltas, the way the kernel actually does. */
function stream(text: string): { shown: string[]; leftover: string } {
	let buffer = ''
	const shown: string[] = []
	for (const ch of text) {
		buffer += ch
		const { ready, rest } = splitCompleteBlocks(buffer)
		if (ready.length > 0) {
			shown.push(ready)
			buffer = rest
		}
	}
	return { shown, leftover: buffer }
}

describe('nothing is released until a block is whole', () => {
	it('holds a single paragraph until the stream ends', () => {
		const { shown, leftover } = stream('A short answer with no blank line in it.')
		expect(shown).toEqual([])
		expect(leftover).toBe('A short answer with no blank line in it.')
	})

	it('never releases a partial word', () => {
		const { shown } = stream('one two three\n\nfour five six\n\nseven')
		for (const chunk of shown) {
			// Every release ends on the boundary that closed it.
			expect(chunk.endsWith('\n')).toBe(true)
		}
	})

	it('releases a paragraph once the next one starts', () => {
		const { shown, leftover } = stream('first para\n\nsecond para')
		expect(shown).toEqual(['first para\n\n'])
		expect(leftover).toBe('second para')
	})

	it('releases each paragraph in turn, losing nothing', () => {
		const text = 'a\n\nb\n\nc'
		const { shown, leftover } = stream(text)
		expect(shown.join('') + leftover).toBe(text)
	})
})

describe('a fenced block is never split', () => {
	it('holds a code block containing a blank line', () => {
		const text = 'Here:\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nafter'
		const { shown, leftover } = stream(text)
		expect(shown.join('') + leftover).toBe(text)
		// The blank line INSIDE the fence must not have produced a release.
		for (const chunk of shown) {
			const fences = (chunk.match(/```/g) ?? []).length
			expect(fences % 2).toBe(0)
		}
	})

	it('treats a tilde fence the same way', () => {
		const { ready } = splitCompleteBlocks('~~~\na\n\nb\n')
		expect(ready).toBe('')
	})

	it('releases the fence once it closes', () => {
		const closed = splitCompleteBlocks('```js\nx\n```\n\ntail')
		expect(closed.ready).toBe('```js\nx\n```\n\n')
		expect(closed.rest).toBe('tail')
	})

	it('allows the indent a list item gives a fence', () => {
		// Up to three spaces is still a fence per CommonMark; four is code.
		const held = splitCompleteBlocks('   ```\na\n\nb\n')
		expect(held.ready).toBe('')
	})
})

describe('edges that would lose or duplicate text', () => {
	it('is empty in and empty out', () => {
		expect(splitCompleteBlocks('')).toEqual({ ready: '', rest: '' })
	})

	it('holds a single newline, which may be half a boundary', () => {
		// One newline is a line break inside a paragraph until a second arrives.
		// Releasing on it would split a paragraph mid-way.
		expect(splitCompleteBlocks('para\n').ready).toBe('')
	})

	it('releases on a completed boundary even at the tail', () => {
		// Two newlines DO close the paragraph: whatever arrives next begins a
		// new block, so there is nothing left for this one to gain by waiting.
		// This assertion was the other way round first, and the round trip
		// through the test is what settled which it should be.
		expect(splitCompleteBlocks('para\n\n')).toEqual({ ready: 'para\n\n', rest: '' })
	})

	it('does not treat a leading blank line as a closed block', () => {
		expect(splitCompleteBlocks('\n\nreal content').ready).toBe('')
	})

	it('splits at the LAST complete boundary, not the first', () => {
		const { ready, rest } = splitCompleteBlocks('a\n\nb\n\nc')
		expect(ready).toBe('a\n\nb\n\n')
		expect(rest).toBe('c')
	})

	it('always partitions the input exactly — no loss, no duplication', () => {
		for (const text of [
			'a\n\nb',
			'```\nx\n\ny\n```\n\nz',
			'\n\n\n\n',
			'no boundaries at all',
			'trailing\n\n',
			'# heading\n\nbody\n\n- one\n- two\n\nend',
		]) {
			const { ready, rest } = splitCompleteBlocks(text)
			expect(ready + rest).toBe(text)
		}
	})
})

describe('splitSafeCut — a paragraph that is taking a while', () => {
	it('releases up to the whitespace after the last sentence end', () => {
		const { ready, rest } = splitSafeCut('First sentence. Second one! Third is still arri')
		expect(ready).toBe('First sentence. Second one! ')
		expect(rest).toBe('Third is still arri')
	})

	it('never cuts mid-word: a period with no whitespace after it is not an end', () => {
		expect(splitSafeCut('Version 3.14 of e.g').ready).toBe('')
		expect(splitSafeCut('Wait for it.').ready).toBe('')
	})

	it('cuts at the LAST safe point — a line end, then a sentence end inside the growing line', () => {
		expect(splitSafeCut('- one. two\n- three four')).toEqual({
			ready: '- one. two\n',
			rest: '- three four',
		})
		expect(splitSafeCut('- one. two\n- three. four')).toEqual({
			ready: '- one. two\n- three. ',
			rest: 'four',
		})
	})

	it('releases a whole line including its trailing newline — unlike the block rule, that is safe', () => {
		expect(splitSafeCut('- one\n')).toEqual({ ready: '- one\n', rest: '' })
	})

	it('does not cut inside an open fence or an open inline code span', () => {
		expect(splitSafeCut('```ts\nconst a = 1. \nconst b').ready).toBe('')
		expect(splitSafeCut('Run `pnpm test. then` now').ready).toBe('')
		expect(splitSafeCut('Run `pnpm test`. Then wait').ready).toBe('Run `pnpm test`. ')
	})

	it('releases nothing for a buffer that has shown no content yet', () => {
		expect(splitSafeCut('\n\n')).toEqual({ ready: '', rest: '\n\n' })
		expect(splitSafeCut('')).toEqual({ ready: '', rest: '' })
	})
})
